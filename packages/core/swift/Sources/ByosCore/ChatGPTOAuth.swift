import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif
#if canImport(Network)
import Network
#endif
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Sign in with ChatGPT for iOS and macOS: OpenAI's way for an app to run on a person's ChatGPT
/// Plus/Pro plan instead of an API key ("ChatGPT plan usage"). Same flow as `@byos/chatgpt-local`:
/// the first sign-in registers the app as the person's own agent (`client_id=dynamic_agent_client`),
/// which issues a per-account client id that later sign-ins reuse. The redirect lands on a loopback
/// listener at `http://127.0.0.1:<port>/auth/callback`. Inference then goes to the Responses API
/// with `store: false`.
public enum ChatGPTOAuth {
    public static let issuer = "https://auth.openai.com"
    public static let authorizeEndpoint = URL(string: "https://auth.openai.com/api/accounts/authorize")!
    public static let tokenURL = URL(string: "https://auth.openai.com/api/accounts/oauth/token")!
    public static let resource = "https://api.openai.com/v1"
    public static let registrationClientID = "dynamic_agent_client"
    public static let scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
    /// The scope that lets the app use the person's plan; sign-in fails without it.
    public static let planUsageScope = "chatgpt.tokens.use.direct"
    /// OpenAI only accepts a `127.0.0.1` loopback callback; `localhost` is refused.
    public static let callbackPorts: [UInt16] = [1455, 54321]
    public static let callbackPath = "/auth/callback"
    /// Refresh when the access token has less than this left.
    public static let refreshWindow: TimeInterval = 120
    /// Refresh errors that mean the grant is dead.
    public static let deadGrantErrors: Set<String> = [
        "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
        "refresh_token_invalidated", "refresh_token_reused",
    ]

    public static func redirectURI(port: UInt16) -> String { "http://127.0.0.1:\(port)\(callbackPath)" }

    /// A started sign-in: the page to open and what the callback is checked against.
    public struct Attempt: Equatable, Sendable {
        public var authorizeURL: URL
        public var state: String
        public var nonce: String
        public var verifier: String
        public var redirectURI: String
        /// The saved issued client id for a returning account; nil registers anew.
        public var savedClientID: String?
    }

    /// Builds an attempt. `appName` is shown on OpenAI's consent page for a first registration;
    /// `hostID` names this install on every sign-in.
    public static func attempt(port: UInt16, appName: String, hostID: String, savedClientID: String?,
                               verifier: String = ClaudeOAuth.randomURLSafe(),
                               state: String = ClaudeOAuth.randomURLSafe(byteCount: 24),
                               nonce: String = ClaudeOAuth.randomURLSafe(byteCount: 24)) -> Attempt {
        let redirect = redirectURI(port: port)
        var fields: [(String, String)] = [
            ("response_type", "code"),
            ("client_id", savedClientID ?? registrationClientID),
            ("redirect_uri", redirect),
            ("scope", scope),
            ("resource", resource),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge", ClaudeOAuth.codeChallenge(for: verifier)),
            ("code_challenge_method", "S256"),
            ("ext_agent_host_id", hostID),
        ]
        if savedClientID == nil { fields.append(("agent_name_hint", appName)) }
        let url = URL(string: "\(authorizeEndpoint.absoluteString)?\(formURLEncoded(fields))")!
        return Attempt(authorizeURL: url, state: state, nonce: nonce, verifier: verifier, redirectURI: redirect, savedClientID: savedClientID)
    }

    /// The code and client id from the loopback callback, after checking `state`, a declined or
    /// failed sign-in, and that a returning account kept its own client id.
    public static func readCallback(_ components: URLComponents, attempt: Attempt) throws -> (code: String, clientID: String) {
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            let values = items.filter { $0.name == name }.compactMap(\.value).filter { !$0.isEmpty }
            return values.count == 1 ? values[0] : nil
        }
        guard items.filter({ $0.name == "state" }).count == 1, value("state") == attempt.state else { throw ChatGPTOAuthError.stateMismatch }
        if let error = value("error") {
            if error == "access_denied" { throw ChatGPTOAuthError.declined }
            throw ChatGPTOAuthError.server(String((value("error_description") ?? error).prefix(200)))
        }
        guard let code = value("code"), code.count <= 4096 else { throw ChatGPTOAuthError.missingCode }
        if let issued = value("client_id"), let saved = attempt.savedClientID, issued != saved { throw ChatGPTOAuthError.stateMismatch }
        guard let clientID = value("client_id") ?? attempt.savedClientID, clientID != registrationClientID, clientID.count <= 512 else {
            throw ChatGPTOAuthError.server("ChatGPT didn't return a client id. Sign in again.")
        }
        return (code, clientID)
    }

    public enum TokenRequest: Equatable, Sendable {
        case authorizationCode(code: String, clientID: String, verifier: String, redirectURI: String)
        case refreshToken(String, clientID: String)
    }

    public static func fields(_ request: TokenRequest) -> [(String, String)] {
        switch request {
        case .authorizationCode(let code, let clientID, let verifier, let redirectURI):
            return [("grant_type", "authorization_code"), ("client_id", clientID), ("code", code),
                    ("code_verifier", verifier), ("redirect_uri", redirectURI), ("resource", resource)]
        case .refreshToken(let token, let clientID):
            return [("grant_type", "refresh_token"), ("client_id", clientID), ("refresh_token", token), ("resource", resource)]
        }
    }

    public static func urlRequest(_ request: TokenRequest) -> URLRequest {
        var urlRequest = URLRequest(url: tokenURL)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        urlRequest.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.httpBody = Data(formURLEncoded(fields(request)).utf8)
        return urlRequest
    }

    /// The payload of a JWT, without checking its signature.
    public static func claims(ofJWT token: String) -> [String: Any]? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var base64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        guard let data = Data(base64Encoded: base64) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// A parsed token response. `scope` is what OpenAI granted.
    public struct TokenResponse: Equatable, Sendable {
        public var tokens: OAuthTokens
        public var scope: String?
    }

    public static func parseTokenResponse(_ payload: Any?, previousRefreshToken: String? = nil, now: Date = Date()) -> TokenResponse? {
        guard var tokens = XAIOAuth.parseTokenResponse(payload, previousRefreshToken: previousRefreshToken, now: now) else { return nil }
        let object = payload as? [String: Any]
        if let id = tokens.idToken { tokens.accountEmail = ClaudeOAuth.shortText(claims(ofJWT: id)?["email"], max: 256) }
        return TokenResponse(tokens: tokens, scope: ClaudeOAuth.shortText(object?["scope"], max: 2048))
    }

    /// Checks the ID token's issuer, audience, nonce and expiry, and that the person granted plan
    /// usage. The token comes straight from OpenAI's token endpoint over TLS, which OpenID Connect
    /// Core 3.1.3.7 accepts in place of a signature check.
    public static func validate(_ response: TokenResponse, clientID: String, nonce: String, now: Date = Date()) throws {
        guard let idToken = response.tokens.idToken, let claims = claims(ofJWT: idToken) else {
            throw ChatGPTOAuthError.server("ChatGPT didn't confirm who signed in. Sign in again.")
        }
        let audience = (claims["aud"] as? String).map { [$0] } ?? (claims["aud"] as? [String]) ?? []
        let expiry = (claims["exp"] as? NSNumber)?.doubleValue ?? 0
        guard (claims["iss"] as? String)?.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == issuer,
              audience.contains(clientID),
              claims["nonce"] as? String == nonce,
              expiry > now.timeIntervalSince1970 - 60 else {
            throw ChatGPTOAuthError.server("ChatGPT's sign-in didn't check out. Sign in again.")
        }
        let granted = response.scope ?? (Self.claims(ofJWT: response.tokens.accessToken)?["scope"] as? String) ?? ""
        guard granted.split(whereSeparator: { $0 == " " || $0 == "+" }).contains(Substring(planUsageScope)) else {
            throw ChatGPTOAuthError.planUsageNotGranted
        }
    }

    /// What a failed token request means.
    public static func classifyTokenError(status: Int, body: Any?) -> ChatGPTOAuthError {
        let object = body as? [String: Any]
        let error = object?["error"] as? String ?? ""
        if error == "invalid_client" { return .invalidClient }
        if deadGrantErrors.contains(error) { return .rejected }
        let detail = (object?["error_description"] as? String).flatMap { ProviderErrors.isInformative($0) ? String($0.prefix(200)) : nil }
            ?? (error.isEmpty ? "HTTP \(status)" : error)
        return .server("ChatGPT sign-in failed: \(detail)")
    }
}

/// Why a ChatGPT sign-in or refresh failed. The message is plain text, safe to show.
public enum ChatGPTOAuthError: LocalizedError, Equatable, Sendable {
    case stateMismatch
    case declined
    case missingCode
    case planUsageNotGranted
    case signInExpired
    case invalidClient
    case rejected
    case timedOut
    case portsBusy
    case server(String)

    public var errorDescription: String? {
        switch self {
        case .stateMismatch: return "ChatGPT sign-in didn't match. Start again."
        case .declined: return "ChatGPT sign-in was cancelled."
        case .missingCode: return "ChatGPT didn't finish signing in. Start again."
        case .planUsageNotGranted: return "ChatGPT signed you in but didn't allow this app to use your plan. Sign in again and allow plan usage."
        case .signInExpired, .rejected, .invalidClient: return "ChatGPT sign-in expired. Sign in again in Settings."
        case .timedOut: return "ChatGPT sign-in timed out. Start again."
        case .portsBusy: return "Couldn't start ChatGPT sign-in because its port is busy. Close other apps signing in to ChatGPT and try again."
        case .server(let message): return message
        }
    }
}

/// What outlives signing out, as OpenAI asks: this install's host id and the issued client id.
public protocol ChatGPTRegistrationStore: AnyObject, Sendable {
    /// This install's `ext_agent_host_id`, made once and kept.
    func hostID() -> String
    func clientID() -> String?
    func saveClientID(_ clientID: String)
    func forgetClientID()
}

func newHostID() -> String { "urn:uuid:" + UUID().uuidString.lowercased() }

public final class MemoryChatGPTRegistrationStore: ChatGPTRegistrationStore, @unchecked Sendable {
    private let lock = NSLock()
    private var host: String?
    private var client: String?
    public init(clientID: String? = nil) { client = clientID }
    public func hostID() -> String { lock.withLock { if host == nil { host = newHostID() }; return host! } }
    public func clientID() -> String? { lock.withLock { client } }
    public func saveClientID(_ clientID: String) { lock.withLock { client = clientID } }
    public func forgetClientID() { lock.withLock { client = nil } }
}

#if canImport(Security)
/// The registration in the Keychain (`service`, accounts `host_id` and `client_id`).
public final class KeychainChatGPTRegistrationStore: ChatGPTRegistrationStore, @unchecked Sendable {
    private let host: KeychainItem<String>
    private let client: KeychainItem<String>
    private let lock = NSLock()
    public init(service: String) {
        host = KeychainItem(service: service, account: "host_id")
        client = KeychainItem(service: service, account: "client_id")
    }
    public func hostID() -> String {
        lock.withLock {
            if let saved = host.load() { return saved }
            let made = newHostID()
            host.save(made)
            return made
        }
    }
    public func clientID() -> String? { client.load() }
    public func saveClientID(_ clientID: String) { client.save(clientID) }
    public func forgetClientID() { client.clear() }
}
#endif

/// Shares one refresh between concurrent callers: ChatGPT refresh tokens rotate, so spending the
/// same one twice signs the person out.
actor RefreshGate {
    private var inFlight: Task<OAuthTokens, Error>?

    func run(_ body: @escaping @Sendable () async throws -> OAuthTokens) async throws -> OAuthTokens {
        if let inFlight { return try await inFlight.value }
        let task = Task { try await body() }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }
}

/// The ChatGPT plan sign-in for an app.
///
/// ```swift
/// let chatgpt = ChatGPTSignIn(appName: "My App",
///     store: KeychainTokenStore(service: "com.example.app.chatgpt"),
///     registration: KeychainChatGPTRegistrationStore(service: "com.example.app.chatgpt"))
/// try await chatgpt.signIn { url in present(url) }   // in-app browser sheet; the app stays in front
/// let token = try await chatgpt.accessToken()       // refreshed with under two minutes left
/// ```
public struct ChatGPTSignIn: Sendable {
    public let appName: String
    public let store: TokenStore
    public let registration: ChatGPTRegistrationStore
    let send: HTTPSend
    let now: @Sendable () -> Date
    let gate = RefreshGate()

    public init(
        appName: String,
        store: TokenStore,
        registration: ChatGPTRegistrationStore,
        send: @escaping HTTPSend = urlSessionSend,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.appName = appName
        self.store = store
        self.registration = registration
        self.send = send
        self.now = now
    }

    public var isSignedIn: Bool { store.load() != nil }

    /// Signs out: drops the tokens, keeps the host id and the issued client id.
    public func signOut() { store.clear() }

    public func begin(port: UInt16) -> ChatGPTOAuth.Attempt {
        ChatGPTOAuth.attempt(port: port, appName: appName, hostID: registration.hostID(), savedClientID: registration.clientID())
    }

    /// Exchanges the callback for tokens, checks them, and saves them with the client id.
    @discardableResult
    public func finish(callback: URLComponents, attempt: ChatGPTOAuth.Attempt) async throws -> OAuthTokens {
        let (code, clientID) = try ChatGPTOAuth.readCallback(callback, attempt: attempt)
        let request = ChatGPTOAuth.TokenRequest.authorizationCode(code: code, clientID: clientID, verifier: attempt.verifier, redirectURI: attempt.redirectURI)
        let (data, response) = try await send(ChatGPTOAuth.urlRequest(request))
        let status = XAISignIn.status(response)
        let body = XAISignIn.json(data)
        guard (200..<300).contains(status) else {
            let error = ChatGPTOAuth.classifyTokenError(status: status, body: body)
            if error == .invalidClient || error == .rejected {
                // The saved registration is gone; the next sign-in registers again.
                registration.forgetClientID()
                throw ChatGPTOAuthError.server("Your ChatGPT connection was reset. Sign in again.")
            }
            throw error
        }
        guard let parsed = ChatGPTOAuth.parseTokenResponse(body, now: now()) else {
            throw ChatGPTOAuthError.server("ChatGPT returned an unexpected sign-in response.")
        }
        try ChatGPTOAuth.validate(parsed, clientID: clientID, nonce: attempt.nonce, now: now())
        registration.saveClientID(clientID)
        store.save(parsed.tokens)
        return parsed.tokens
    }

    #if canImport(Network)
    /// The whole sign-in: listens on a loopback port, lets `present` show the page (an in-app
    /// browser sheet keeps the app in front and the listener up), and finishes on the redirect.
    @discardableResult
    public func signIn(timeout: TimeInterval = 600, present: @escaping @MainActor @Sendable (URL) -> Void) async throws -> OAuthTokens {
        var listener: LoopbackCallbackListener?
        for port in ChatGPTOAuth.callbackPorts {
            if let started = try? await LoopbackCallbackListener.start(port: port, path: ChatGPTOAuth.callbackPath) {
                listener = started
                break
            }
        }
        guard let listener else { throw ChatGPTOAuthError.portsBusy }
        defer { listener.stop() }
        let attempt = begin(port: listener.port)
        await present(attempt.authorizeURL)
        let callback = try await listener.waitForCallback(timeout: timeout)
        return try await finish(callback: callback, attempt: attempt)
    }
    #endif

    /// Refreshes the stored tokens, one request at a time. A dead grant clears the tokens; an
    /// unknown client also forgets the registration.
    @discardableResult
    public func refresh() async throws -> OAuthTokens {
        try await refresh(onlyIfStale: false)
    }

    func refresh(onlyIfStale: Bool) async throws -> OAuthTokens {
        try await gate.run { [self] in
            // A caller that queued behind another refresh finds fresh tokens and spends nothing.
            if onlyIfStale, let current = store.load(), !current.needsRefresh(within: ChatGPTOAuth.refreshWindow, now: now()) {
                return current
            }
            guard let saved = store.load(), let refreshToken = saved.refreshToken, let clientID = registration.clientID() else {
                store.clear()
                throw ChatGPTOAuthError.signInExpired
            }
            let (data, response) = try await send(ChatGPTOAuth.urlRequest(.refreshToken(refreshToken, clientID: clientID)))
            let status = XAISignIn.status(response)
            let body = XAISignIn.json(data)
            guard (200..<300).contains(status) else {
                let error = ChatGPTOAuth.classifyTokenError(status: status, body: body)
                if error == .invalidClient { registration.forgetClientID() }
                if error == .invalidClient || error == .rejected {
                    store.clear()
                    throw ChatGPTOAuthError.signInExpired
                }
                throw error
            }
            guard var tokens = ChatGPTOAuth.parseTokenResponse(body, previousRefreshToken: refreshToken, now: now())?.tokens else {
                throw ChatGPTOAuthError.server("ChatGPT returned an unexpected sign-in response.")
            }
            if tokens.idToken == nil { tokens.idToken = saved.idToken }
            if tokens.accountEmail == nil { tokens.accountEmail = saved.accountEmail }
            store.save(tokens)
            return tokens
        }
    }

    /// A usable access token, refreshed first with under two minutes left. Nil when signed out.
    /// A passing refresh failure returns the current token while it still works.
    public func accessToken() async throws -> String? {
        guard let saved = store.load() else { return nil }
        guard saved.needsRefresh(within: ChatGPTOAuth.refreshWindow, now: now()) else { return saved.accessToken }
        do {
            return try await refresh(onlyIfStale: true).accessToken
        } catch ChatGPTOAuthError.signInExpired {
            throw ChatGPTOAuthError.signInExpired
        } catch where saved.expiresAt > now() {
            return saved.accessToken
        }
    }
}

#if canImport(Network)
/// Accepts the one redirect ChatGPT sends to `http://127.0.0.1:<port>/auth/callback`.
final class LoopbackCallbackListener: @unchecked Sendable {
    let port: UInt16
    private let path: String
    private let listener: NWListener
    private let queue = DispatchQueue(label: "byos.chatgpt-callback")
    private var waiter: CheckedContinuation<URLComponents, Error>?
    private var result: Result<URLComponents, Error>?

    private init(port: UInt16, path: String, listener: NWListener) {
        self.port = port
        self.path = path
        self.listener = listener
    }

    static func start(port: UInt16, path: String) async throws -> LoopbackCallbackListener {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        let listener = try NWListener(using: parameters)
        let callback = LoopbackCallbackListener(port: port, path: path, listener: listener)
        listener.newConnectionHandler = { [weak callback] connection in callback?.handle(connection) }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = ResumeOnce()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    once.run { continuation.resume() }
                case .failed(let error), .waiting(let error):
                    once.run {
                        listener.cancel()
                        continuation.resume(throwing: error)
                    }
                case .cancelled:
                    once.run { continuation.resume(throwing: CancellationError()) }
                default:
                    break
                }
            }
            listener.start(queue: callback.queue)
        }
        return callback
    }

    func waitForCallback(timeout: TimeInterval) async throws -> URLComponents {
        queue.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.finish(.failure(ChatGPTOAuthError.timedOut)) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    if let result = self.result {
                        continuation.resume(with: result)
                    } else {
                        self.waiter = continuation
                    }
                }
            }
        } onCancel: {
            self.finish(.failure(CancellationError()))
        }
    }

    func stop() { listener.cancel() }

    private func finish(_ outcome: Result<URLComponents, Error>) {
        queue.async {
            guard self.result == nil else { return }
            self.result = outcome
            self.waiter?.resume(with: outcome)
            self.waiter = nil
        }
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if buffer.range(of: Data("\r\n\r\n".utf8)) == nil, !isComplete, error == nil, buffer.count < 65_536 {
                self.receive(connection, buffer: buffer)
                return
            }
            self.respond(to: buffer, on: connection)
        }
    }

    private func respond(to request: Data, on connection: NWConnection) {
        let firstLine = String(decoding: request.prefix(8192), as: UTF8.self).components(separatedBy: "\r\n").first ?? ""
        let parts = firstLine.split(separator: " ")
        let target = parts.count >= 2 && parts[0] == "GET" ? String(parts[1]) : ""
        let components = URLComponents(string: "http://127.0.0.1:\(port)\(target)")
        let isCallback = components?.path == path
        let body = isCallback
            ? "<!doctype html><meta name=viewport content=\"width=device-width\"><body style=\"font:17px -apple-system,system-ui;padding:40px;text-align:center\"><h2>Signed in to ChatGPT</h2><p>You can return to the app.</p></body>"
            : "Not found"
        let head = "HTTP/1.1 \(isCallback ? "200 OK" : "404 Not Found")\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in connection.cancel() })
        if isCallback, let components { finish(.success(components)) }
    }
}

/// Runs its body once; the listener's state handler runs on one queue, so no lock is needed.
private final class ResumeOnce: @unchecked Sendable {
    private var done = false
    func run(_ body: () -> Void) {
        guard !done else { return }
        done = true
        body()
    }
}
#endif
