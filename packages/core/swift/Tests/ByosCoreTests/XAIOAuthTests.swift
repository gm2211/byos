import Foundation
import XCTest
@testable import ByosCore

/// Runs the vectors @byos/core's TypeScript tests use (conformance/xai-oauth.json), then the
/// sign-in client against a stub auth server.
final class XAIOAuthTests: XCTestCase {
    static func vectors() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/xai-oauth.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    static func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }

    func testConstantsMatch() throws {
        let c = try Self.vectors()["constants"] as! [String: Any]
        XCTAssertEqual(XAIOAuth.clientID, c["clientId"] as? String)
        XCTAssertEqual(XAIOAuth.deviceCodeURL.absoluteString, c["deviceCodeUrl"] as? String)
        XCTAssertEqual(XAIOAuth.tokenURL.absoluteString, c["tokenUrl"] as? String)
        XCTAssertEqual(XAIOAuth.scope, c["scope"] as? String)
        XCTAssertEqual(XAIOAuth.deviceCodeGrant, c["deviceCodeGrant"] as? String)
        XCTAssertEqual(XAIOAuth.refreshWindow * 1000, c["refreshWindowMs"] as? Double)
        XCTAssertEqual(XAIOAuth.defaultLifetime, c["defaultLifetimeSeconds"] as? Double)
        XCTAssertEqual(XAIOAuth.deviceMaxWait, c["deviceMaxWaitSeconds"] as? Double)
        XCTAssertEqual(XAIOAuth.deviceDefaultExpires, c["deviceDefaultExpiresSeconds"] as? Double)
        XCTAssertEqual(XAIOAuth.slowDownStep, c["slowDownSeconds"] as? Double)
        XCTAssertEqual(XAIOAuth.formHeaders, try Self.vectors()["headers"] as? [String: String])
    }

    func testRequestsMatch() throws {
        for case let vector as [String: Any] in try Self.vectors()["requests"] as! [Any] {
            let input = vector["input"] as! [String: Any]
            let request: XAIOAuth.TokenRequest
            switch input["kind"] as! String {
            case "device_start": request = .deviceStart
            case "device_code": request = .deviceCode(input["deviceCode"] as! String)
            default: request = .refreshToken(input["refreshToken"] as! String)
            }
            let fields = (vector["fields"] as! [[String]]).map { ($0[0], $0[1]) }
            XCTAssertEqual(XAIOAuth.fields(request).map { [$0.0, $0.1] }, fields.map { [$0.0, $0.1] })
            let urlRequest = XAIOAuth.urlRequest(request)
            XCTAssertEqual(urlRequest.url?.absoluteString, vector["url"] as? String)
            XCTAssertEqual(urlRequest.httpMethod, vector["method"] as? String)
            XCTAssertEqual(String(data: urlRequest.httpBody!, encoding: .utf8), vector["body"] as? String)
        }
    }

    func testTokenResponsesMatch() throws {
        let v = try Self.vectors()
        let now = Date(timeIntervalSince1970: (v["now"] as! Double) / 1000)
        for case let vector as [String: Any] in v["tokenResponses"] as! [Any] {
            let name = vector["name"] as! String
            let tokens = XAIOAuth.parseTokenResponse(vector["payload"], previousRefreshToken: vector["previousRefreshToken"] as? String, now: now)
            guard let expected = vector["expected"] as? [String: Any] else {
                XCTAssertNil(tokens, name)
                continue
            }
            XCTAssertEqual(tokens?.accessToken, expected["accessToken"] as? String, name)
            XCTAssertEqual(tokens?.refreshToken, expected["refreshToken"] as? String, name)
            XCTAssertEqual(tokens?.idToken, expected["idToken"] as? String, name)
            XCTAssertEqual(tokens.map { Self.ms($0.expiresAt) }, expected["expiresAt"] as? Double, name)
        }
    }

    func testDeviceStartsMatch() throws {
        let v = try Self.vectors()
        let now = Date(timeIntervalSince1970: (v["now"] as! Double) / 1000)
        for case let vector as [String: Any] in v["deviceStart"] as! [Any] {
            let name = vector["name"] as! String
            let start = XAIOAuth.parseDeviceStart(vector["payload"], now: now)
            guard let expected = vector["expected"] as? [String: Any] else {
                XCTAssertNil(start, name)
                continue
            }
            XCTAssertEqual(start?.deviceCode, expected["deviceCode"] as? String, name)
            XCTAssertEqual(start?.userCode, expected["userCode"] as? String, name)
            XCTAssertEqual(start?.verificationURI.absoluteString, expected["verificationUri"] as? String, name)
            XCTAssertEqual(start?.verificationURIComplete?.absoluteString, expected["verificationUriComplete"] as? String, name)
            XCTAssertEqual(start?.interval, expected["intervalSeconds"] as? Double, name)
            XCTAssertEqual(start.map { Self.ms($0.expiresAt) }, expected["expiresAt"] as? Double, name)
        }
    }

    func testPollAndRefreshClassificationMatch() throws {
        let v = try Self.vectors()
        for case let vector as [String: Any] in v["pollErrors"] as! [Any] {
            XCTAssertEqual(XAIOAuth.classifyPollError(status: vector["status"] as! Int, body: vector["body"]).rawValue, vector["expected"] as? String)
        }
        for case let vector as [String: Any] in v["refreshFailures"] as! [Any] {
            XCTAssertEqual(XAIOAuth.classifyRefreshFailure(status: vector["status"] as! Int).rawValue, vector["expected"] as? String)
        }
    }

    /// Answers each request with the next reply (status, JSON body) or error.
    final class AuthServer: @unchecked Sendable {
        enum Reply { case json(Int, String), error(URLError) }
        private let lock = NSLock()
        private var replies: [Reply]
        private(set) var requests: [URLRequest] = []
        init(_ replies: [Reply]) { self.replies = replies }
        var send: HTTPSend {
            { request in
                let reply: Reply = self.lock.withLock {
                    self.requests.append(request)
                    return self.replies.removeFirst()
                }
                switch reply {
                case .error(let error): throw error
                case .json(let status, let body):
                    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
                    return (Data(body.utf8), response)
                }
            }
        }
    }

    final class Waits: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [TimeInterval] = []
        func add(_ value: TimeInterval) { lock.withLock { values.append(value) } }
        var all: [TimeInterval] { lock.withLock { values } }
    }

    static let start = #"{"device_code":"d","user_code":"U-1","verification_uri":"https://auth.x.ai/device","interval":1,"expires_in":600}"#

    func testDeviceSignInPollsThroughPendingSlowDownAndADroppedConnection() async throws {
        let server = AuthServer([
            .json(200, Self.start),
            .json(400, #"{"error":"authorization_pending"}"#),
            .error(URLError(.networkConnectionLost)),
            .json(400, #"{"error":"slow_down"}"#),
            .json(200, #"{"access_token":"a1","refresh_token":"r1","expires_in":3600}"#),
        ])
        let store = MemoryTokenStore()
        let waits = Waits()
        let grok = XAISignIn(store: store, send: server.send, sleep: { s in waits.add(s) })
        let start = try await grok.begin()
        XCTAssertEqual(start.userCode, "U-1")
        let tokens = try await grok.complete(start)
        XCTAssertEqual(tokens.accessToken, "a1")
        XCTAssertEqual(store.load()?.refreshToken, "r1")
        XCTAssertEqual(waits.all, [1, 1, 1, 6], "slow_down adds 5s to the interval")
        XCTAssertEqual(server.requests.count, 5)
    }

    func testDeclinedSignInThrowsAPlainMessage() async throws {
        let server = AuthServer([.json(200, Self.start), .json(400, #"{"error":"access_denied"}"#)])
        let grok = XAISignIn(store: MemoryTokenStore(), send: server.send, sleep: { _ in })
        do {
            try await grok.complete(try await grok.begin())
            XCTFail("expected declined")
        } catch let error as XAIOAuthError {
            XCTAssertEqual(error, .declined)
            XCTAssertEqual(error.errorDescription, "xAI sign-in was declined.")
        }
    }

    func testAccessTokenRefreshesNearExpiryAndADeadGrantSignsOut() async throws {
        let now = Date()
        let store = MemoryTokenStore(OAuthTokens(accessToken: "old", refreshToken: "r1", expiresAt: now.addingTimeInterval(60)))
        let server = AuthServer([.json(200, #"{"access_token":"new","expires_in":3600}"#), .json(401, "{}")])
        let grok = XAISignIn(store: store, send: server.send, sleep: { _ in }, now: { now })
        let token = try await grok.accessToken()
        XCTAssertEqual(token, "new")
        XCTAssertEqual(store.load()?.refreshToken, "r1", "a missing refresh token keeps the previous one")
        let fresh = try await grok.accessToken()
        XCTAssertEqual(fresh, "new", "no refresh while the token has more than 5 minutes left")
        XCTAssertEqual(server.requests.count, 1)

        store.save(OAuthTokens(accessToken: "new", refreshToken: "r1", expiresAt: now.addingTimeInterval(60)))
        do {
            _ = try await grok.accessToken()
            XCTFail("expected signInExpired")
        } catch let error as XAIOAuthError {
            XCTAssertEqual(error, .signInExpired)
        }
        XCTAssertNil(store.load(), "a dead grant clears the store")
    }

    func testATransientRefreshFailureKeepsAWorkingToken() async throws {
        let now = Date()
        let store = MemoryTokenStore(OAuthTokens(accessToken: "still-good", refreshToken: "r1", expiresAt: now.addingTimeInterval(60)))
        let server = AuthServer([.json(503, "{}")])
        let grok = XAISignIn(store: store, send: server.send, sleep: { _ in }, now: { now })
        let token = try await grok.accessToken()
        XCTAssertEqual(token, "still-good")
        XCTAssertNotNil(store.load())
    }
}
