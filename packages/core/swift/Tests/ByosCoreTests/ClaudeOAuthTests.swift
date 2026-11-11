import Foundation
import XCTest
@testable import ByosCore

/// Runs the vectors @byos/core's TypeScript tests use (conformance/claude-oauth.json), then the
/// sign-in client against a stub token endpoint.
final class ClaudeOAuthTests: XCTestCase {
    static func vectors() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/claude-oauth.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    func testConstantsMatch() throws {
        let c = try Self.vectors()["constants"] as! [String: Any]
        XCTAssertEqual(ClaudeOAuth.clientID, c["clientId"] as? String)
        XCTAssertEqual(ClaudeOAuth.authorizeEndpoint.absoluteString, c["authorizeUrl"] as? String)
        XCTAssertEqual(ClaudeOAuth.tokenURL.absoluteString, c["tokenUrl"] as? String)
        XCTAssertEqual(ClaudeOAuth.scope, c["scope"] as? String)
        XCTAssertEqual(ClaudeOAuth.pasteRedirectURI, c["pasteRedirectUri"] as? String)
        XCTAssertEqual(ClaudeOAuth.oauthBeta, c["oauthBeta"] as? String)
        XCTAssertEqual(ClaudeOAuth.claudeCodeSystemPrefix, c["claudeCodeSystemPrefix"] as? String)
        XCTAssertEqual(ClaudeOAuth.refreshWindow, c["refreshWindowSeconds"] as? Double)
        XCTAssertEqual(ClaudeOAuth.defaultLifetime, c["defaultLifetimeSeconds"] as? Double)
    }

    func testPKCEAndAuthorizeURLMatch() throws {
        let v = try Self.vectors()
        let pkce = v["pkce"] as! [String: String]
        XCTAssertEqual(ClaudeOAuth.codeChallenge(for: pkce["verifier"]!), pkce["challenge"])
        let a = v["authorize"] as! [String: String]
        XCTAssertEqual(ClaudeOAuth.authorizeURL(challenge: a["challenge"]!, state: a["state"]!, redirectURI: a["redirectUri"]!).absoluteString, a["url"])
    }

    func testANewAttemptIsUsable() {
        let attempt = ClaudeOAuth.Attempt.new()
        XCTAssertEqual(attempt.verifier.count, 43)
        XCTAssertNotEqual(attempt.state, attempt.verifier)
        let items = URLComponents(url: attempt.authorizeURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first { $0.name == "code_challenge" }?.value, ClaudeOAuth.codeChallenge(for: attempt.verifier))
        XCTAssertEqual(items.first { $0.name == "state" }?.value, attempt.state)
    }

    func testPastedCodesMatch() throws {
        let v = try Self.vectors()
        let state = v["expectedState"] as! String
        for case let c as [String: Any] in v["pasted"] as! [Any] {
            let expect = c["expect"] as! [String: String]
            let result = ClaudeOAuth.readPastedCode(c["input"] as! String, expectedState: state)
            switch result {
            case .success(let code): XCTAssertEqual(code, expect["code"], c["name"] as! String)
            case .failure(let problem): XCTAssertEqual(problem.rawValue, expect["error"], c["name"] as! String)
            }
        }
    }

    func testTokenRequestsMatch() throws {
        for case let c as [String: Any] in try Self.vectors()["tokenRequests"] as! [Any] {
            let input = c["input"] as! [String: String]
            let request: ClaudeOAuth.TokenRequest = input["kind"] == "authorization_code"
                ? .authorizationCode(code: input["code"]!, state: input["state"]!, verifier: input["verifier"]!, redirectURI: input["redirectUri"]!)
                : .refreshToken(input["refreshToken"]!)
            XCTAssertEqual(ClaudeOAuth.body(request), c["body"] as? [String: String])
            let sent = try JSONSerialization.jsonObject(with: ClaudeOAuth.urlRequest(request).httpBody!) as? [String: String]
            XCTAssertEqual(sent, c["body"] as? [String: String])
        }
    }

    func testTokenResponsesAndRefreshFailuresMatch() throws {
        let v = try Self.vectors()
        let now = Date(timeIntervalSince1970: v["now"] as! Double)
        for case let c as [String: Any] in v["tokenResponses"] as! [Any] {
            let name = c["name"] as! String
            let tokens = ClaudeOAuth.parseTokenResponse(c["payload"], previousRefreshToken: c["previousRefreshToken"] as? String, now: now)
            guard let expect = c["expect"] as? [String: Any] else { XCTAssertNil(tokens, name); continue }
            XCTAssertEqual(tokens?.accessToken, expect["accessToken"] as? String, name)
            XCTAssertEqual(tokens?.refreshToken, expect["refreshToken"] as? String, name)
            XCTAssertEqual(tokens?.accountEmail, expect["accountEmail"] as? String, name)
            XCTAssertEqual(tokens?.expiresAt.timeIntervalSince1970, expect["expiresAt"] as? Double, name)
        }
        for case let c as [String: Any] in v["refreshFailures"] as! [Any] {
            XCTAssertEqual(ClaudeOAuth.classifyRefreshFailure(status: c["status"] as! Int).rawValue, c["expect"] as? String)
        }
    }

    func testSignInResumesTheAttemptAndExchangesThePastedCode() async throws {
        let server = XAIOAuthTests.AuthServer([.json(200, #"{"access_token":"a1","refresh_token":"r1","expires_in":28800}"#)])
        let store = MemoryTokenStore()
        let claude = ClaudeSignIn(store: store, attempts: MemoryClaudeAttemptStore(), send: server.send)
        let attempt = claude.beginOrResume()
        XCTAssertEqual(claude.beginOrResume(), attempt, "tapping sign-in again reopens the same attempt")
        do {
            try await claude.finish(pasted: "123456")
            XCTFail("expected the email login code to be refused")
        } catch let error as ClaudeOAuthError {
            XCTAssertEqual(error, .pastedCode(.emailLoginCode))
        }
        XCTAssertEqual(server.requests.count, 0)
        let tokens = try await claude.finish(pasted: "CODE123#\(attempt.state)")
        XCTAssertEqual(tokens.accessToken, "a1")
        XCTAssertEqual(store.load()?.refreshToken, "r1")
        XCTAssertNil(claude.pendingAttempt, "a successful exchange ends the attempt")
        let sent = try JSONSerialization.jsonObject(with: server.requests[0].httpBody!) as? [String: String]
        XCTAssertEqual(sent?["code_verifier"], attempt.verifier)
    }

    func testAccessTokenRefreshesNearExpiryAndADeadGrantSignsOut() async throws {
        let now = Date()
        let store = MemoryTokenStore(OAuthTokens(accessToken: "old", refreshToken: "r1", expiresAt: now.addingTimeInterval(30), accountEmail: "p@example.com"))
        let server = XAIOAuthTests.AuthServer([.json(200, #"{"access_token":"new","expires_in":28800}"#), .json(400, #"{"error":"invalid_grant"}"#)])
        let claude = ClaudeSignIn(store: store, attempts: MemoryClaudeAttemptStore(), send: server.send, now: { now })
        let token = try await claude.accessToken()
        XCTAssertEqual(token, "new")
        XCTAssertEqual(store.load()?.refreshToken, "r1")
        XCTAssertEqual(store.load()?.accountEmail, "p@example.com")
        store.save(OAuthTokens(accessToken: "new", refreshToken: "r1", expiresAt: now.addingTimeInterval(30)))
        do {
            _ = try await claude.accessToken()
            XCTFail("expected signInExpired")
        } catch let error as ClaudeOAuthError {
            XCTAssertEqual(error, .signInExpired)
            XCTAssertEqual(error.errorDescription, "Claude sign-in expired. Sign in again.")
        }
        XCTAssertNil(store.load())
    }
}
