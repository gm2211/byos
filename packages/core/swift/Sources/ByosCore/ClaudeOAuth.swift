import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Claude Pro/Max subscription OAuth for iOS and macOS; mirrors `claude-oauth.ts` in @byos/core and
/// runs the same vectors (../conformance/claude-oauth.json).
///
/// The public Claude Code client's PKCE flow with the paste-back redirect: the person approves on
/// claude.com, Claude shows a `CODE#STATE` string, and they paste it into the app. The endpoints,
/// client id and scope are undocumented and can change. A native app calls the token endpoint
/// directly; tokens never cross the app's own server.
public enum ClaudeOAuth {
    public static let clientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    public static let authorizeEndpoint = URL(string: "https://claude.com/cai/oauth/authorize")!
    public static let tokenURL = URL(string: "https://platform.claude.com/v1/oauth/token")!
    public static let scope = "user:profile user:inference"
    /// The page that shows the `CODE#STATE` string for the person to copy back.
    public static let pasteRedirectURI = "https://platform.claude.com/oauth/code/callback"
    /// `anthropic-beta` flags a subscription Bearer token needs.
    public static let oauthBeta = "oauth-2025-04-20,claude-code-20250219"
    /// Subscription tokens are only honoured for requests that open with this system block.
    public static let claudeCodeSystemPrefix = "You are Claude Code, Anthropic's official CLI for Claude."
    /// Refresh when the access token has less than this left.
    public static let refreshWindow: TimeInterval = 60
    /// Lifetime assumed when a token response omits a usable `expires_in`.
    public static let defaultLifetime: TimeInterval = 3600

    /// The PKCE S256 challenge for `verifier` (base64url SHA-256, no padding).
    public static func codeChallenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func randomURLSafe(byteCount: Int = 32) -> String {
        var generator = SystemRandomNumberGenerator()
        return base64URL(Data((0..<byteCount).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
    }

    /// The authorize URL, with the query encoded exactly as the TypeScript `claudeAuthorizeUrl`.
    public static func authorizeURL(challenge: String, state: String, redirectURI: String = pasteRedirectURI) -> URL {
        let query = formURLEncoded([
            ("code", "true"),
            ("client_id", clientID),
            ("response_type", "code"),
            ("redirect_uri", redirectURI),
            ("scope", scope),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ])
        return URL(string: "\(authorizeEndpoint.absoluteString)?\(query)")!
    }

    /// One sign-in attempt: the PKCE verifier and state behind its authorize URL. Codable so it can
    /// outlive the app being suspended or relaunched while the person approves in a browser (often
    /// signing in through an emailed link on the way, which takes minutes).
    public struct Attempt: Codable, Equatable, Sendable {
        public var authorizeURL: URL
        public var state: String
        public var verifier: String
        public var redirectURI: String
        public var createdAt: Date

        public static func new(now: Date = Date()) -> Attempt {
            let verifier = randomURLSafe()
            let state = randomURLSafe()
            return Attempt(
                authorizeURL: ClaudeOAuth.authorizeURL(challenge: codeChallenge(for: verifier), state: state),
                state: state, verifier: verifier, redirectURI: pasteRedirectURI, createdAt: now)
        }
    }

    public enum PastedCodeProblem: String, Error, Sendable {
        /// Nothing usable was pasted.
        case missing
        /// A code from another attempt, whose verifier is gone.
        case stateMismatch = "state-mismatch"
        /// The short number Claude emails for logging in, which belongs on Claude's page.
        case emailLoginCode = "email-login-code"
    }

    /// The authorization code in what the person pasted: `CODE#STATE` (as Claude's page shows it), a
    /// bare code, or the whole callback URL. Spaces and line breaks picked up while copying are
    /// dropped. Same rules as `readClaudePastedCode` in TypeScript.
    public static func readPastedCode(_ pasted: String, expectedState: String) -> Result<String, PastedCodeProblem> {
        let text = String(pasted.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) })
        var code: String?
        var state: String?
        if text.lowercased().hasPrefix("http://") || text.lowercased().hasPrefix("https://") {
            guard let components = URLComponents(string: text) else { return .failure(.missing) }
            code = components.queryItems?.first { $0.name == "code" }?.value
            state = components.queryItems?.first { $0.name == "state" }?.value
                ?? components.fragment.flatMap { $0.isEmpty ? nil : $0 }
        } else if let hash = text.firstIndex(of: "#") {
            code = String(text[..<hash])
            state = String(text[text.index(after: hash)...])
        } else {
            code = text
        }
        guard let code, !code.isEmpty, code.count <= 4096 else { return .failure(.missing) }
        if state == nil, code.count <= 10, code.allSatisfy({ $0.isASCII && $0.isNumber }) { return .failure(.emailLoginCode) }
        if let state, !state.isEmpty, state != expectedState { return .failure(.stateMismatch) }
        return .success(code)
    }

    public enum TokenRequest: Equatable, Sendable {
        case authorizationCode(code: String, state: String, verifier: String, redirectURI: String)
        case refreshToken(String)
    }

    /// Exactly the JSON body the token endpoint takes.
    public static func body(_ request: TokenRequest) -> [String: String] {
        switch request {
        case .authorizationCode(let code, let state, let verifier, let redirectURI):
            return ["grant_type": "authorization_code", "code": code, "state": state, "client_id": clientID,
                    "redirect_uri": redirectURI, "code_verifier": verifier]
        case .refreshToken(let token):
            return ["grant_type": "refresh_token", "refresh_token": token, "client_id": clientID]
        }
    }

    public static func urlRequest(_ request: TokenRequest) -> URLRequest {
        var urlRequest = URLRequest(url: tokenURL)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.httpBody = try? JSONSerialization.data(withJSONObject: body(request), options: [.sortedKeys])
        return urlRequest
    }

    static func shortText(_ value: Any?, max: Int) -> String? {
        guard let text = value as? String, !text.isEmpty, text.utf16.count <= max,
              !text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else { return nil }
        return text
    }

    /// Validates a token response and keeps only what a client needs. A missing refresh token
    /// keeps `previousRefreshToken`; a missing `expires_in` assumes an hour. Nil without a usable
    /// access token.
    public static func parseTokenResponse(_ payload: Any?, previousRefreshToken: String? = nil, now: Date = Date()) -> OAuthTokens? {
        guard let object = payload as? [String: Any], let access = shortText(object["access_token"], max: 32_768) else { return nil }
        let lifetime = XAIOAuth.seconds(object["expires_in"]) ?? defaultLifetime
        let email = (object["account"] as? [String: Any]).flatMap { shortText($0["email_address"], max: 256) }
        return OAuthTokens(
            accessToken: access,
            refreshToken: shortText(object["refresh_token"], max: 32_768) ?? previousRefreshToken,
            expiresAt: now.addingTimeInterval(min(lifetime, XAIOAuth.maxLifetime)),
            accountEmail: email)
    }

    /// 400 and 401 mean the refresh grant is dead; anything else may pass.
    public static func classifyRefreshFailure(status: Int) -> XAIOAuth.RefreshFailure {
        status == 400 || status == 401 ? .reconnect : .transient
    }
}

/// Why a Claude sign-in or refresh failed. The message is plain text, safe to show.
public enum ClaudeOAuthError: LocalizedError, Equatable, Sendable {
    case noAttempt
    case pastedCode(ClaudeOAuth.PastedCodeProblem)
    case exchangeFailed(status: Int)
    case malformedResponse
    /// The refresh grant is gone; the person signs in again.
    case signInExpired
    case refreshFailed(status: Int)

    public var errorDescription: String? {
        switch self {
        case .noAttempt, .pastedCode(.missing): return "Paste the code Claude shows after Authorize."
        case .pastedCode(.stateMismatch):
            return "That code is from a different sign-in. Open Claude again, tap Authorize, and copy the new code."
        case .pastedCode(.emailLoginCode):
            return "That's the login code from Claude's email. Enter it on Claude's page, then tap Authorize and paste the code Claude shows."
        case .exchangeFailed(let status): return "Claude didn't accept that code (\(status)). Start the sign-in again."
        case .malformedResponse: return "Claude returned an invalid token response."
        case .signInExpired: return "Claude sign-in expired. Sign in again."
        case .refreshFailed(let status): return "Claude couldn't renew the sign-in (\(status)). Try again shortly."
        }
    }
}

/// Where the in-flight Claude sign-in attempt lives, so the verifier survives the app being
/// suspended or relaunched. Only a successful exchange, a cancel or signing out removes it.
public protocol ClaudeAttemptStore: AnyObject, Sendable {
    func load() -> ClaudeOAuth.Attempt?
    func save(_ attempt: ClaudeOAuth.Attempt)
    func clear()
}

public final class MemoryClaudeAttemptStore: ClaudeAttemptStore, @unchecked Sendable {
    private let lock = NSLock()
    private var attempt: ClaudeOAuth.Attempt?
    public init() {}
    public func load() -> ClaudeOAuth.Attempt? { lock.lock(); defer { lock.unlock() }; return attempt }
    public func save(_ attempt: ClaudeOAuth.Attempt) { lock.lock(); self.attempt = attempt; lock.unlock() }
    public func clear() { lock.lock(); attempt = nil; lock.unlock() }
}

#if canImport(Security)
/// The attempt in the Keychain (`service`, account `pending_sign_in`).
public final class KeychainClaudeAttemptStore: ClaudeAttemptStore, @unchecked Sendable {
    private let item: KeychainItem<ClaudeOAuth.Attempt>
    public init(service: String) { item = KeychainItem(service: service, account: "pending_sign_in") }
    public func load() -> ClaudeOAuth.Attempt? { item.load() }
    public func save(_ attempt: ClaudeOAuth.Attempt) { item.save(attempt) }
    public func clear() { item.clear() }
}
#endif

/// The Claude Pro/Max sign-in for an app: starts (or resumes) an attempt, exchanges the pasted
/// code, keeps the tokens in `store`, and hands out a fresh access token.
///
/// ```swift
/// let claude = ClaudeSignIn(
///     store: KeychainTokenStore(service: "com.example.app.claude"),
///     attempts: KeychainClaudeAttemptStore(service: "com.example.app.claude"))
/// let attempt = claude.beginOrResume()        // open attempt.authorizeURL
/// try await claude.finish(pasted: text)       // throws ClaudeOAuthError with a plain message
/// let token = try await claude.accessToken()  // send with anthropic-beta: ClaudeOAuth.oauthBeta
/// ```
public struct ClaudeSignIn: Sendable {
    public let store: TokenStore
    public let attempts: ClaudeAttemptStore
    let send: HTTPSend
    let now: @Sendable () -> Date

    public init(
        store: TokenStore,
        attempts: ClaudeAttemptStore,
        send: @escaping HTTPSend = urlSessionSend,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.store = store
        self.attempts = attempts
        self.send = send
        self.now = now
    }

    public var isSignedIn: Bool { store.load() != nil }

    /// The attempt in flight, if any (for reopening the paste screen when the app comes back).
    public var pendingAttempt: ClaudeOAuth.Attempt? { attempts.load() }

    /// The saved attempt if there is one, so a code the person already has still matches;
    /// otherwise a new attempt, saved before it is returned.
    public func beginOrResume() -> ClaudeOAuth.Attempt {
        if let pending = attempts.load() { return pending }
        let attempt = ClaudeOAuth.Attempt.new(now: now())
        attempts.save(attempt)
        return attempt
    }

    public func cancel() { attempts.clear() }

    public func signOut() {
        store.clear()
        attempts.clear()
    }

    /// Exchanges the pasted code for tokens; on success the attempt ends.
    @discardableResult
    public func finish(pasted: String) async throws -> OAuthTokens {
        guard let attempt = attempts.load() else { throw ClaudeOAuthError.noAttempt }
        let code: String
        switch ClaudeOAuth.readPastedCode(pasted, expectedState: attempt.state) {
        case .success(let value): code = value
        case .failure(let problem): throw ClaudeOAuthError.pastedCode(problem)
        }
        let request = ClaudeOAuth.TokenRequest.authorizationCode(
            code: code, state: attempt.state, verifier: attempt.verifier, redirectURI: attempt.redirectURI)
        let (data, response) = try await send(ClaudeOAuth.urlRequest(request))
        let status = XAISignIn.status(response)
        guard (200..<300).contains(status) else { throw ClaudeOAuthError.exchangeFailed(status: status) }
        guard let tokens = ClaudeOAuth.parseTokenResponse(XAISignIn.json(data), now: now()) else { throw ClaudeOAuthError.malformedResponse }
        store.save(tokens)
        attempts.clear()
        return tokens
    }

    /// Refreshes the stored tokens. A dead grant (400, 401) clears the store; anything else keeps it.
    @discardableResult
    public func refresh() async throws -> OAuthTokens {
        guard let saved = store.load(), let refreshToken = saved.refreshToken else {
            store.clear()
            throw ClaudeOAuthError.signInExpired
        }
        let (data, response) = try await send(ClaudeOAuth.urlRequest(.refreshToken(refreshToken)))
        let status = XAISignIn.status(response)
        guard (200..<300).contains(status) else {
            if ClaudeOAuth.classifyRefreshFailure(status: status) == .reconnect {
                store.clear()
                throw ClaudeOAuthError.signInExpired
            }
            throw ClaudeOAuthError.refreshFailed(status: status)
        }
        guard var tokens = ClaudeOAuth.parseTokenResponse(XAISignIn.json(data), previousRefreshToken: refreshToken, now: now()) else {
            throw ClaudeOAuthError.malformedResponse
        }
        if tokens.accountEmail == nil { tokens.accountEmail = saved.accountEmail }
        store.save(tokens)
        return tokens
    }

    /// A usable access token, refreshed first when it has less than a minute left. Nil when nobody
    /// is signed in. Without a refresh token, or when a refresh fails for a passing reason while the
    /// token still works, the current token is returned and the request decides.
    public func accessToken() async throws -> String? {
        guard let saved = store.load() else { return nil }
        guard saved.refreshToken != nil, saved.needsRefresh(within: ClaudeOAuth.refreshWindow, now: now()) else { return saved.accessToken }
        do {
            return try await refresh().accessToken
        } catch ClaudeOAuthError.refreshFailed where saved.expiresAt > now() {
            return saved.accessToken
        } catch let error where isTransientNetworkError(error) && saved.expiresAt > now() {
            return saved.accessToken
        }
    }

    /// The headers a subscription request to api.anthropic.com carries with this token.
    public static func requestHeaders(accessToken: String) -> [String: String] {
        ["Authorization": "Bearer \(accessToken)", "anthropic-beta": ClaudeOAuth.oauthBeta, "anthropic-version": "2023-06-01"]
    }
}
