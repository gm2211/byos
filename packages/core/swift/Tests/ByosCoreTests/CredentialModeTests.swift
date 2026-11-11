import Foundation
import XCTest
@testable import ByosCore

/// Runs the vectors @byos/core's TypeScript tests use, so web and Swift cannot drift apart.
final class CredentialModeTests: XCTestCase {
    struct Vectors: Decodable {
        struct Parse: Decodable { let input: String?; let expect: String }
        struct Provider: Decodable { let id: String; let signIn: [String] }
        let modes: [String]
        let `default`: String
        let methodKinds: [String: String]
        let parse: [Parse]
        let allows: [String: [String]]
        let providers: [Provider]
        let expect: [String: [Provider]]
    }

    static func vectors() throws -> Vectors {
        // swift/Tests/ByosCoreTests/ -> core package root -> conformance/
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/credential-mode.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    static func method(_ kind: String) -> SignInMethod {
        switch kind {
        case "device-code": return .deviceCode(handshakeViaSite: false)
        case "pkce": return .pkce(handshakeViaSite: false)
        case "paste-token": return .pasteToken(hint: "t")
        case "api-key": return .apiKey(hint: "k")
        default: fatalError("unknown method kind \(kind)")
        }
    }

    func testModesDefaultAndParsing() throws {
        let v = try Self.vectors()
        XCTAssertEqual(CredentialMode.allCases.map(\.rawValue), v.modes)
        XCTAssertEqual(CredentialMode.default.rawValue, v.default)
        for case_ in v.parse {
            XCTAssertEqual(CredentialMode(parsing: case_.input).rawValue, case_.expect, String(describing: case_.input))
        }
        XCTAssertEqual(CredentialMode(parsing: "bogus", fallback: .subscription), .subscription)
    }

    func testMethodKindsAndAllows() throws {
        let v = try Self.vectors()
        for (kind, expected) in v.methodKinds {
            let method = Self.method(kind)
            XCTAssertEqual(method.kind, kind)
            XCTAssertEqual(method.credentialKind.rawValue, expected, kind)
        }
        for mode in CredentialMode.allCases {
            for kind in CredentialKind.allCases {
                XCTAssertEqual(mode.allows(kind), v.allows[mode.rawValue]?.contains(kind.rawValue), "\(mode)/\(kind)")
            }
        }
    }

    func testProviderFiltering() throws {
        let v = try Self.vectors()
        let providers = v.providers.map { ProviderDescriptor(id: $0.id, displayName: $0.id, signIn: $0.signIn.map(Self.method)) }
        for mode in CredentialMode.allCases {
            let got = mode.providers(providers).map { [$0.id] + $0.signIn.map(\.kind) }
            let want = (v.expect[mode.rawValue] ?? []).map { [$0.id] + $0.signIn }
            XCTAssertEqual(got, want, mode.rawValue)
        }
    }

    func testRequireRefusesDisallowedCredentials() {
        XCTAssertNoThrow(try CredentialMode.subscriptionAndAPIKey.require(.apiKey))
        XCTAssertNoThrow(try CredentialMode.subscription.require(.subscription))
        XCTAssertThrowsError(try CredentialMode.subscription.require(.apiKey)) { error in
            XCTAssertEqual(error as? CredentialModeError, CredentialModeError(mode: .subscription, kind: .apiKey))
            XCTAssertEqual(error.localizedDescription, "API keys are turned off in this app.")
        }
        XCTAssertThrowsError(try CredentialMode.apiKey.require(.subscription))
    }
}
