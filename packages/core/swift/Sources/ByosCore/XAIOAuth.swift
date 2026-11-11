import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// xAI (Grok subscription) OAuth for iOS and macOS; mirrors `xai-oauth.ts` in @byos/core and runs the
/// same vectors (../conformance/xai-oauth.json).
///
/// The device-code flow (RFC 8628) against auth.x.ai with the public Grok CLI client: xAI has no
/// public OAuth client for third-party apps, and the endpoints, client id and scope are undocumented
/// and can change. A native app calls auth.x.ai directly; tokens never cross the app's own server.
public enum XAIOAuth {
    public static let clientID = "b1a00492-073a-47ea-816f-4c329264a828"
    public static let deviceCodeURL = URL(string: "https://auth.x.ai/oauth2/device/code")!
    public static let tokenURL = URL(string: "https://auth.x.ai/oauth2/token")!
    public static let scope = "openid profile email offline_access grok-cli:access api:access"
    public static let deviceCodeGrant = "urn:ietf:params:oauth:grant-type:device_code"
    /// Refresh when the access token has less than this left.
    public static let refreshWindow: TimeInterval = 300
    /// Lifetime assumed when a token response omits a usable `expires_in`.
    public static let defaultLifetime: TimeInterval = 3600
    public static let deviceMaxWait: TimeInterval = 900
    public static let deviceDefaultExpires: TimeInterval = 300
    public static let slowDownStep: TimeInterval = 5
    /// Exactly the headers xAI's token endpoint is sent.
    public static let formHeaders = ["Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"]

    static let maxLifetime: TimeInterval = 365 * 24 * 60 * 60
    static let maxTokenLength = 32_768

    public enum TokenRequest: Equatable, Sendable {
        case deviceStart
        case deviceCode(String)
        case refreshToken(String)
    }

    /// Form fields in canonical order.
    public static func fields(_ request: TokenRequest) -> [(String, String)] {
        switch request {
        case .deviceStart:
            return [("client_id", clientID), ("scope", scope)]
        case .deviceCode(let code):
            return [("grant_type", deviceCodeGrant), ("client_id", clientID), ("device_code", code)]
        case .refreshToken(let token):
            return [("grant_type", "refresh_token"), ("refresh_token", token), ("client_id", clientID)]
        }
    }

    public static func url(_ request: TokenRequest) -> URL {
        if case .deviceStart = request { return deviceCodeURL }
        return tokenURL
    }

    public static func urlRequest(_ request: TokenRequest) -> URLRequest {
        var urlRequest = URLRequest(url: url(request))
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 20
        for (name, value) in formHeaders { urlRequest.setValue(value, forHTTPHeaderField: name) }
        urlRequest.httpBody = Data(formURLEncoded(fields(request)).utf8)
        return urlRequest
    }

    static func tokenText(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty, text.utf16.count <= maxTokenLength,
              !text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else { return nil }
        return text
    }

    static func seconds(_ value: Any?) -> TimeInterval? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let seconds = number.doubleValue
        return seconds.isFinite && seconds > 0 ? seconds : nil
    }

    /// Validates a token response. A missing refresh token keeps `previousRefreshToken`; a missing or
    /// non-positive `expires_in` means 3600s. Nil without a usable access token.
    public static func parseTokenResponse(_ payload: Any?, previousRefreshToken: String? = nil, now: Date = Date()) -> OAuthTokens? {
        guard let object = payload as? [String: Any], let access = tokenText(object["access_token"]) else { return nil }
        let lifetime = min(seconds(object["expires_in"]) ?? defaultLifetime, maxLifetime)
        return OAuthTokens(
            accessToken: access,
            refreshToken: tokenText(object["refresh_token"]) ?? previousRefreshToken,
            idToken: tokenText(object["id_token"]),
            expiresAt: now.addingTimeInterval(lifetime))
    }

    public struct DeviceStart: Equatable, Sendable {
        public var deviceCode: String
        public var userCode: String
        public var verificationURI: URL
        /// The page with the code already filled in, when xAI sent a safe one.
        public var verificationURIComplete: URL?
        public var interval: TimeInterval
        public var expiresAt: Date

        /// The page to open for the person.
        public var pageToOpen: URL { verificationURIComplete ?? verificationURI }
    }

    static func safeHTTPS(_ value: Any?) -> URL? {
        guard let text = value as? String, !text.isEmpty, text.count <= 2_048,
              text == text.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }),
              let components = URLComponents(string: text), components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false, components.user == nil, components.password == nil,
              let url = components.url else { return nil }
        return url
    }

    /// Validates a device-authorization response; interval defaults to 5s (at least 1s), expires_in
    /// to 300s (capped at 900s).
    public static func parseDeviceStart(_ payload: Any?, now: Date = Date()) -> DeviceStart? {
        guard let object = payload as? [String: Any],
              let deviceCode = tokenText(object["device_code"]),
              let userCode = tokenText(object["user_code"]), userCode.count <= 256,
              let uri = safeHTTPS(object["verification_uri"]) else { return nil }
        let expires = min(seconds(object["expires_in"]) ?? deviceDefaultExpires, deviceMaxWait)
        return DeviceStart(
            deviceCode: deviceCode, userCode: userCode, verificationURI: uri,
            verificationURIComplete: safeHTTPS(object["verification_uri_complete"]),
            interval: max(1, seconds(object["interval"]) ?? 5),
            expiresAt: now.addingTimeInterval(expires))
    }

    public enum PollOutcome: String, Sendable {
        case pending
        case slowDown = "slow_down"
        case declined
        case expired
        case failed
    }

    /// Classifies a non-OK device-code poll answer by its OAuth `error` code.
    public static func classifyPollError(status: Int, body: Any?) -> PollOutcome {
        switch (body as? [String: Any])?["error"] as? String {
        case "authorization_pending": return .pending
        case "slow_down": return .slowDown
        case "access_denied", "authorization_denied": return .declined
        case "expired_token": return .expired
        default: return .failed
        }
    }

    public enum RefreshFailure: String, Sendable {
        /// The grant is dead: sign in again.
        case reconnect
        /// May pass (403, 429, 5xx, network): keep the tokens and try later.
        case transient
    }

    public static func classifyRefreshFailure(status: Int) -> RefreshFailure {
        status == 400 || status == 401 ? .reconnect : .transient
    }
}

/// Why a Grok sign-in or refresh failed. The message is plain text, safe to show.
public enum XAIOAuthError: LocalizedError, Equatable, Sendable {
    case startFailed(status: Int)
    case malformedResponse
    case declined
    case expired
    case timedOut
    case failed(status: Int, detail: String?)
    /// The refresh grant is gone; the person signs in again.
    case signInExpired
    case refreshFailed(status: Int)

    public var errorDescription: String? {
        switch self {
        case .startFailed(let status): return "xAI sign-in failed to start (\(status))."
        case .malformedResponse: return "xAI returned an unexpected sign-in response."
        case .declined: return "xAI sign-in was declined."
        case .expired: return "The xAI sign-in code expired. Start again."
        case .timedOut: return "Timed out waiting for xAI sign-in."
        case .failed(let status, let detail):
            return ["xAI sign-in failed (\(status)).", detail].compactMap { $0 }.joined(separator: " ")
        case .signInExpired: return "SuperGrok sign-in expired. Sign in again."
        case .refreshFailed(let status): return "SuperGrok token refresh failed (\(status))."
        }
    }
}

/// The Grok subscription sign-in for an app: starts the device code, polls until the person
/// approves, keeps the tokens in `store`, and hands out a fresh access token.
///
/// ```swift
/// let grok = XAISignIn(store: KeychainTokenStore(service: "com.example.app.xai"))
/// let start = try await grok.begin()          // show start.userCode, open start.pageToOpen
/// try await grok.complete(start)              // polls; saves the tokens
/// let token = try await grok.accessToken()    // refreshed within 5 minutes of expiry
/// ```
public struct XAISignIn: Sendable {
    public let store: TokenStore
    let send: HTTPSend
    let sleep: @Sendable (TimeInterval) async throws -> Void
    let now: @Sendable () -> Date

    public init(
        store: TokenStore,
        send: @escaping HTTPSend = urlSessionSend,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = busySleep,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.store = store
        self.send = send
        self.sleep = sleep
        self.now = now
    }

    public var isSignedIn: Bool { store.load() != nil }

    public func signOut() { store.clear() }

    static func status(_ response: URLResponse) -> Int { (response as? HTTPURLResponse)?.statusCode ?? -1 }

    static func json(_ data: Data) -> Any? { try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) }

    public func begin() async throws -> XAIOAuth.DeviceStart {
        let (data, response) = try await send(XAIOAuth.urlRequest(.deviceStart))
        let status = Self.status(response)
        guard (200..<300).contains(status) else { throw XAIOAuthError.startFailed(status: status) }
        guard let start = XAIOAuth.parseDeviceStart(Self.json(data), now: now()) else { throw XAIOAuthError.malformedResponse }
        return start
    }

    /// Polls until the person approves, declines, or the code expires, then saves the tokens. A
    /// dropped connection while the app was in the background does not end the sign-in.
    @discardableResult
    public func complete(_ start: XAIOAuth.DeviceStart) async throws -> OAuthTokens {
        var interval = start.interval
        while now() < start.expiresAt {
            try await sleep(interval)
            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await send(XAIOAuth.urlRequest(.deviceCode(start.deviceCode)))
            } catch where isTransientNetworkError(error) {
                continue
            }
            let status = Self.status(response)
            let body = Self.json(data)
            if (200..<300).contains(status) {
                guard let tokens = XAIOAuth.parseTokenResponse(body, now: now()) else { throw XAIOAuthError.malformedResponse }
                store.save(tokens)
                return tokens
            }
            switch XAIOAuth.classifyPollError(status: status, body: body) {
            case .pending: continue
            case .slowDown: interval += XAIOAuth.slowDownStep
            case .declined: throw XAIOAuthError.declined
            case .expired: throw XAIOAuthError.expired
            case .failed:
                let detail = (body as? [String: Any])?["error_description"] as? String
                throw XAIOAuthError.failed(status: status, detail: detail.flatMap { ProviderErrors.isInformative($0) ? String($0.prefix(200)) : nil })
            }
        }
        throw XAIOAuthError.timedOut
    }

    /// Refreshes the stored tokens. A dead grant (400, 401) clears the store; anything else keeps it.
    @discardableResult
    public func refresh() async throws -> OAuthTokens {
        guard let saved = store.load(), let refreshToken = saved.refreshToken else {
            store.clear()
            throw XAIOAuthError.signInExpired
        }
        let (data, response) = try await send(XAIOAuth.urlRequest(.refreshToken(refreshToken)))
        let status = Self.status(response)
        guard (200..<300).contains(status) else {
            if XAIOAuth.classifyRefreshFailure(status: status) == .reconnect {
                store.clear()
                throw XAIOAuthError.signInExpired
            }
            throw XAIOAuthError.refreshFailed(status: status)
        }
        guard let tokens = XAIOAuth.parseTokenResponse(Self.json(data), previousRefreshToken: refreshToken, now: now()) else {
            throw XAIOAuthError.malformedResponse
        }
        store.save(tokens)
        return tokens
    }

    /// A usable access token, refreshed first when it has less than `XAIOAuth.refreshWindow` left.
    /// Nil when nobody is signed in. A transient refresh failure falls back to the current token
    /// while it still works.
    public func accessToken() async throws -> String? {
        guard let saved = store.load() else { return nil }
        guard saved.needsRefresh(within: XAIOAuth.refreshWindow, now: now()) else { return saved.accessToken }
        do {
            return try await refresh().accessToken
        } catch XAIOAuthError.refreshFailed where saved.expiresAt > now() {
            return saved.accessToken
        } catch let error where isTransientNetworkError(error) && saved.expiresAt > now() {
            return saved.accessToken
        }
    }
}
