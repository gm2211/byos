import Foundation
#if canImport(Security)
import Security
#endif

/// A signed-in account's tokens. `expiresAt` is when the access token stops working.
public struct OAuthTokens: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String?
    public var idToken: String?
    public var expiresAt: Date

    public init(accessToken: String, refreshToken: String? = nil, idToken: String? = nil, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
        self.expiresAt = expiresAt
    }

    /// True when the access token has less than `window` left.
    public func needsRefresh(within window: TimeInterval, now: Date = Date()) -> Bool {
        expiresAt.timeIntervalSince(now) <= window
    }
}

/// Where one provider's tokens live. Keep each provider in its own store, so signing out of one
/// never touches another.
public protocol TokenStore: AnyObject, Sendable {
    func load() -> OAuthTokens?
    func save(_ tokens: OAuthTokens)
    func clear()
}

/// Tokens in memory only; for tests and previews.
public final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: OAuthTokens?

    public init(_ tokens: OAuthTokens? = nil) { self.tokens = tokens }

    public func load() -> OAuthTokens? { lock.lock(); defer { lock.unlock() }; return tokens }
    public func save(_ tokens: OAuthTokens) { lock.lock(); self.tokens = tokens; lock.unlock() }
    public func clear() { lock.lock(); tokens = nil; lock.unlock() }
}

#if canImport(Security)
/// Tokens in the Keychain as one generic-password item (`service`, account `tokens`), readable after
/// the first unlock so background refreshes work, and never synced to iCloud.
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    public let service: String
    private let account = "tokens"

    public init(service: String) { self.service = service }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() -> OAuthTokens? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(OAuthTokens.self, from: data)
    }

    public func save(_ tokens: OAuthTokens) {
        guard let data = try? JSONEncoder().encode(tokens) else { return }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }
}
#endif

/// Sends one request; `URLSession.shared.data(for:)` by default. Tests pass a stub.
public typealias HTTPSend = @Sendable (URLRequest) async throws -> (Data, URLResponse)

public let urlSessionSend: HTTPSend = { request in try await URLSession.shared.data(for: request) }

/// `application/x-www-form-urlencoded`, encoded as browsers' URLSearchParams does (space as `+`).
public func formURLEncoded(_ fields: [(String, String)]) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*-._ ")
    func encode(_ text: String) -> String {
        (text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text).replacingOccurrences(of: " ", with: "+")
    }
    return fields.map { "\(encode($0.0))=\(encode($0.1))" }.joined(separator: "&")
}

/// Network failures that say nothing about a sign-in in progress: the app was suspended while the
/// person approved in a browser, or the connection briefly dropped. A device-code poll goes on.
public func isTransientNetworkError(_ error: Error) -> Bool {
    guard let urlError = error as? URLError else { return false }
    switch urlError.code {
    case .networkConnectionLost, .timedOut, .notConnectedToInternet, .cannotConnectToHost, .dnsLookupFailed,
         .backgroundSessionWasDisconnected:
        return true
    default:
        return false
    }
}
