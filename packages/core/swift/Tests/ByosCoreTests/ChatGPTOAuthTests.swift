import Foundation
import XCTest
@testable import ByosCore

final class ChatGPTOAuthTests: XCTestCase {
    static func jwt(_ claims: [String: Any]) -> String {
        let payload = try! JSONSerialization.data(withJSONObject: claims)
        return "e30.\(ClaudeOAuth.base64URL(payload)).sig"
    }

    static func attempt(savedClientID: String? = nil) -> ChatGPTOAuth.Attempt {
        ChatGPTOAuth.attempt(port: 1455, appName: "Test App", hostID: "urn:uuid:host", savedClientID: savedClientID,
                             verifier: "verifier-verifier-verifier-verifier-verifier", state: "state-1", nonce: "nonce-1")
    }

    static func callback(_ query: String) -> URLComponents { URLComponents(string: "http://127.0.0.1:1455/auth/callback?\(query)")! }

    func testAFirstSignInRegistersAndAReturningOneReusesItsClient() {
        let first = URLComponents(url: Self.attempt().authorizeURL, resolvingAgainstBaseURL: false)!
        let items = Dictionary(uniqueKeysWithValues: first.queryItems!.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items["client_id"], "dynamic_agent_client")
        XCTAssertEqual(items["agent_name_hint"], "Test App")
        XCTAssertEqual(items["redirect_uri"], "http://127.0.0.1:1455/auth/callback")
        XCTAssertEqual(items["scope"], ChatGPTOAuth.scope)
        XCTAssertEqual(items["ext_agent_host_id"], "urn:uuid:host")
        XCTAssertEqual(items["code_challenge"], ClaudeOAuth.codeChallenge(for: "verifier-verifier-verifier-verifier-verifier"))
        XCTAssertTrue(first.percentEncodedQuery!.contains("scope=openid+profile"), "spaces encode as + like URLSearchParams")
        let returning = URLComponents(url: Self.attempt(savedClientID: "client-9").authorizeURL, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(returning.queryItems?.first { $0.name == "client_id" }?.value, "client-9")
        XCTAssertNil(returning.queryItems?.first { $0.name == "agent_name_hint" })
    }

    func testTheCallbackIsChecked() throws {
        let attempt = Self.attempt()
        let ok = try ChatGPTOAuth.readCallback(Self.callback("code=c1&state=state-1&client_id=client-9"), attempt: attempt)
        XCTAssertEqual(ok.code, "c1")
        XCTAssertEqual(ok.clientID, "client-9")
        XCTAssertThrowsError(try ChatGPTOAuth.readCallback(Self.callback("code=c1&state=other&client_id=c"), attempt: attempt)) {
            XCTAssertEqual($0 as? ChatGPTOAuthError, .stateMismatch)
        }
        XCTAssertThrowsError(try ChatGPTOAuth.readCallback(Self.callback("code=c1&state=state-1&state=state-1&client_id=c"), attempt: attempt)) {
            XCTAssertEqual($0 as? ChatGPTOAuthError, .stateMismatch, "a repeated state is refused")
        }
        XCTAssertThrowsError(try ChatGPTOAuth.readCallback(Self.callback("error=access_denied&state=state-1"), attempt: attempt)) {
            XCTAssertEqual($0 as? ChatGPTOAuthError, .declined)
        }
        XCTAssertThrowsError(try ChatGPTOAuth.readCallback(Self.callback("state=state-1&client_id=c"), attempt: attempt)) {
            XCTAssertEqual($0 as? ChatGPTOAuthError, .missingCode)
        }
        XCTAssertThrowsError(try ChatGPTOAuth.readCallback(Self.callback("code=c1&state=state-1&client_id=dynamic_agent_client"), attempt: attempt))
        XCTAssertThrowsError(try ChatGPTOAuth.readCallback(Self.callback("code=c1&state=state-1&client_id=new"), attempt: Self.attempt(savedClientID: "old"))) {
            XCTAssertEqual($0 as? ChatGPTOAuthError, .stateMismatch, "a returning account keeps its own client")
        }
    }

    func testTheIDTokenAndPlanUsageAreChecked() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        func response(aud: Any = "client-9", nonce: String = "nonce-1", exp: Double = 1_700_003_600, scope: String? = ChatGPTOAuth.scope) -> ChatGPTOAuth.TokenResponse {
            let id = Self.jwt(["iss": "https://auth.openai.com/", "aud": aud, "nonce": nonce, "exp": exp, "email": "p@example.com"])
            var payload: [String: Any] = ["access_token": "a1", "refresh_token": "r1", "id_token": id, "expires_in": 3600]
            if let scope { payload["scope"] = scope }
            return ChatGPTOAuth.parseTokenResponse(payload, now: now)!
        }
        XCTAssertEqual(response().tokens.accountEmail, "p@example.com")
        XCTAssertNoThrow(try ChatGPTOAuth.validate(response(), clientID: "client-9", nonce: "nonce-1", now: now))
        XCTAssertNoThrow(try ChatGPTOAuth.validate(response(aud: ["x", "client-9"]), clientID: "client-9", nonce: "nonce-1", now: now))
        XCTAssertThrowsError(try ChatGPTOAuth.validate(response(aud: "other"), clientID: "client-9", nonce: "nonce-1", now: now))
        XCTAssertThrowsError(try ChatGPTOAuth.validate(response(nonce: "replayed"), clientID: "client-9", nonce: "nonce-1", now: now))
        XCTAssertThrowsError(try ChatGPTOAuth.validate(response(exp: 1_699_990_000), clientID: "client-9", nonce: "nonce-1", now: now))
        XCTAssertThrowsError(try ChatGPTOAuth.validate(response(scope: "openid profile"), clientID: "client-9", nonce: "nonce-1", now: now)) {
            XCTAssertEqual($0 as? ChatGPTOAuthError, .planUsageNotGranted)
        }
    }

    func testTokenErrorsClassify() {
        XCTAssertEqual(ChatGPTOAuth.classifyTokenError(status: 401, body: ["error": "invalid_client"]), .invalidClient)
        XCTAssertEqual(ChatGPTOAuth.classifyTokenError(status: 400, body: ["error": "refresh_token_reused"]), .rejected)
        XCTAssertEqual(ChatGPTOAuth.classifyTokenError(status: 500, body: nil), .server("ChatGPT sign-in failed: HTTP 500"))
    }

    func testSignInFinishesAndSavesTheClient() async throws {
        let id = Self.jwt(["iss": "https://auth.openai.com", "aud": "client-9", "nonce": "nonce-1", "exp": Date().timeIntervalSince1970 + 3600])
        let server = XAIOAuthTests.AuthServer([.json(200, #"{"access_token":"a1","refresh_token":"r1","id_token":"\#(id)","scope":"\#(ChatGPTOAuth.scope)","expires_in":3600}"#)])
        let registration = MemoryChatGPTRegistrationStore()
        let store = MemoryTokenStore()
        let chatgpt = ChatGPTSignIn(appName: "Test App", store: store, registration: registration, send: server.send)
        let tokens = try await chatgpt.finish(callback: Self.callback("code=c1&state=state-1&client_id=client-9"), attempt: Self.attempt())
        XCTAssertEqual(tokens.accessToken, "a1")
        XCTAssertEqual(registration.clientID(), "client-9")
        let body = String(data: server.requests[0].httpBody!, encoding: .utf8)!
        XCTAssertTrue(body.contains("resource=https%3A%2F%2Fapi.openai.com%2Fv1"))
        chatgpt.signOut()
        XCTAssertNil(store.load())
        XCTAssertEqual(registration.clientID(), "client-9", "signing out keeps the registration")
    }

    func testConcurrentRefreshesShareOneRequest() async throws {
        let now = Date()
        let store = MemoryTokenStore(OAuthTokens(accessToken: "old", refreshToken: "r1", expiresAt: now.addingTimeInterval(30)))
        let server = XAIOAuthTests.AuthServer([.json(200, #"{"access_token":"new","refresh_token":"r2","expires_in":3600}"#)])
        let chatgpt = ChatGPTSignIn(appName: "Test App", store: store, registration: MemoryChatGPTRegistrationStore(clientID: "client-9"), send: server.send, now: { now })
        async let first = chatgpt.accessToken()
        async let second = chatgpt.accessToken()
        let tokens = try await [first, second]
        XCTAssertEqual(tokens, ["new", "new"])
        XCTAssertEqual(server.requests.count, 1, "a rotating refresh token is spent once")
        XCTAssertEqual(store.load()?.refreshToken, "r2")
    }

    func testAnUnknownClientSignsOutAndForgetsTheRegistration() async throws {
        let now = Date()
        let store = MemoryTokenStore(OAuthTokens(accessToken: "old", refreshToken: "r1", expiresAt: now.addingTimeInterval(30)))
        let registration = MemoryChatGPTRegistrationStore(clientID: "client-9")
        let server = XAIOAuthTests.AuthServer([.json(401, #"{"error":"invalid_client"}"#)])
        let chatgpt = ChatGPTSignIn(appName: "Test App", store: store, registration: registration, send: server.send, now: { now })
        do {
            _ = try await chatgpt.accessToken()
            XCTFail("expected signInExpired")
        } catch let error as ChatGPTOAuthError {
            XCTAssertEqual(error, .signInExpired)
        }
        XCTAssertNil(store.load())
        XCTAssertNil(registration.clientID())
    }
}
