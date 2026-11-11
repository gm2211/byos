import Foundation

/// How a person connects a provider; mirrors `SignInMethod` in @byos/core (provider.ts).
public enum SignInMethod: Equatable, Hashable, Sendable {
    /// OAuth device code: show a code, the user approves on the provider's site.
    case deviceCode(handshakeViaSite: Bool)
    /// OAuth PKCE redirect, or a provider page that shows a code to paste back.
    case pkce(handshakeViaSite: Bool, completion: PKCECompletion = .redirect)
    /// A token the user generated themselves for their account (for example `claude setup-token`).
    case pasteToken(hint: String)
    /// A pay-as-you-go API key, with optional provider-owned pages that get one.
    case apiKey(hint: String, setup: [APIKeySetupStep] = [])

    public enum PKCECompletion: String, Sendable, Hashable {
        case redirect
        case pasteCode = "paste-code"
    }

    /// The `kind` string used by @byos/core: "device-code", "pkce", "paste-token" or "api-key".
    public var kind: String {
        switch self {
        case .deviceCode: "device-code"
        case .pkce: "pkce"
        case .pasteToken: "paste-token"
        case .apiKey: "api-key"
        }
    }

    /// `.apiKey` for a pasted pay-as-you-go key; every other method signs in to an account.
    public var credentialKind: CredentialKind {
        if case .apiKey = self { return .apiKey }
        return .subscription
    }
}

/// One provider-owned page a user visits to get an API key. Links only.
public struct APIKeySetupStep: Equatable, Hashable, Sendable {
    public var label: String
    public var url: URL

    public init(label: String, url: URL) {
        self.label = label
        self.url = url
    }
}

/// Anything that declares its sign-in methods, so `CredentialMode.providers(_:)` can filter it.
/// Conform your own provider type, or use `ProviderDescriptor`.
public protocol SignInDeclaring {
    var signIn: [SignInMethod] { get set }
}

/// A provider's identity and sign-in methods, in the order the UI lists them.
public struct ProviderDescriptor: SignInDeclaring, Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var displayName: String
    /// Empty for a credential-free provider, such as an on-device model.
    public var signIn: [SignInMethod]

    public init(id: String, displayName: String, signIn: [SignInMethod]) {
        self.id = id
        self.displayName = displayName
        self.signIn = signIn
    }
}
