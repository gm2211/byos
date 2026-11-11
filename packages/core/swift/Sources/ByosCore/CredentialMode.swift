import Foundation

/// What a sign-in method connects: an account plan, or a pay-as-you-go API key.
public enum CredentialKind: String, CaseIterable, Codable, Sendable {
    case subscription
    case apiKey = "api-key"
}

/// Which kinds of credential an app lets people connect; mirrors `CredentialMode` in @byos/core.
///
/// - `subscriptionAndAPIKey`: plan sign-ins and API keys (the default).
/// - `subscription`: plan sign-ins only (Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok...). Show no API
///   key field and never send a stored key.
/// - `apiKey`: API keys only.
///
/// Credential-free providers (on-device models) are unaffected. The raw values, defaults and
/// filtering match ../conformance/credential-mode.json, which both packages test against.
public enum CredentialMode: String, CaseIterable, Codable, Sendable {
    case subscriptionAndAPIKey = "subscription-and-api-key"
    case subscription
    case apiKey = "api-key"

    public static let `default`: CredentialMode = .subscriptionAndAPIKey

    /// The mode `value` names, else `fallback`. For modes read from settings or configuration.
    public init(parsing value: String?, fallback: CredentialMode = .default) {
        self = value.flatMap(CredentialMode.init(rawValue:)) ?? fallback
    }

    public func allows(_ kind: CredentialKind) -> Bool {
        self == .subscriptionAndAPIKey || rawValue == kind.rawValue
    }

    public func allows(_ method: SignInMethod) -> Bool {
        allows(method.credentialKind)
    }

    /// The methods this mode allows, in their declared order.
    public func signInMethods(_ methods: [SignInMethod]) -> [SignInMethod] {
        methods.filter(allows)
    }

    /// The providers this mode offers, each with only its allowed sign-in methods. A provider whose
    /// every method is filtered out is dropped; one that declares none (credential-free) is kept.
    public func providers<P: SignInDeclaring>(_ providers: [P]) -> [P] {
        providers.compactMap { provider in
            guard !provider.signIn.isEmpty else { return provider }
            let allowed = signInMethods(provider.signIn)
            guard !allowed.isEmpty else { return nil }
            var filtered = provider
            filtered.signIn = allowed
            return filtered
        }
    }

    /// Guard for request paths: throws before a credential of `kind` is used when this mode does not
    /// allow it, so a key stored under an earlier mode is never sent.
    public func require(_ kind: CredentialKind) throws {
        guard allows(kind) else { throw CredentialModeError(mode: self, kind: kind) }
    }
}

/// Thrown by `CredentialMode.require(_:)`. The message is fixed text, safe to show.
public struct CredentialModeError: Error, LocalizedError, Equatable, Sendable {
    public let mode: CredentialMode
    public let kind: CredentialKind

    public init(mode: CredentialMode, kind: CredentialKind) {
        self.mode = mode
        self.kind = kind
    }

    public var errorDescription: String? {
        kind == .apiKey ? "API keys are turned off in this app." : "Subscription sign-in is turned off in this app."
    }
}
