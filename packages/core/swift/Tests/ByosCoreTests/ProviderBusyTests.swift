import Foundation
import XCTest
@testable import ByosCore

/// Runs the vectors @byos/core's TypeScript tests use (conformance/provider-busy.json).
final class ProviderBusyTests: XCTestCase {
    struct Expect: Decodable {
        let action: String
        let waitSeconds: TimeInterval?
        let cooldownSeconds: TimeInterval?
        let message: String?
    }
    struct Decide: Decodable {
        let name: String
        let provider: String
        let status: Int
        let headers: [String: String]
        let body: String
        let attempt: Int
        let lane: RequestLane
        let expect: Expect
    }
    struct Message: Decodable {
        let provider: String
        let status: Int
        let headers: [String: String]?
        let body: String
        let expect: String
    }
    struct LongDetail: Decodable {
        let provider: String
        let status: Int
        let `repeat`: String
        let count: Int
        let expectPrefix: String
        let expectDetailLength: Int
        let expectSuffix: String
    }
    struct Policy: Decodable {
        let busyStatuses: [Int]
        let backoffSeconds: [TimeInterval]
        let waitLimitSeconds: TimeInterval
        let defaultCooldownSeconds: TimeInterval
        let planLimitMessageAfterSeconds: TimeInterval
        let lostConnectionRetrySeconds: [TimeInterval]
    }
    struct Vectors: Decodable {
        let policy: Policy
        let now: TimeInterval
        let providers: [String: BusyProvider]
        let decide: [Decide]
        let messages: [Message]
        let longDetail: LongDetail
    }

    static func vectors() throws -> Vectors {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/provider-busy.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    static let stubReset: ResetFormatter = { _, _ in "{reset}" }

    func testPolicyMatchesTheVectors() throws {
        let policy = try Self.vectors().policy
        XCTAssertEqual(BusyPolicy.busyStatuses, Set(policy.busyStatuses))
        XCTAssertEqual(BusyPolicy.backoff, policy.backoffSeconds)
        XCTAssertEqual(BusyPolicy.waitLimit, policy.waitLimitSeconds)
        XCTAssertEqual(BusyPolicy.defaultCooldown, policy.defaultCooldownSeconds)
        XCTAssertEqual(BusyPolicy.planLimitMessageAfter, policy.planLimitMessageAfterSeconds)
        XCTAssertEqual(BusyPolicy.lostConnectionRetryDelays, policy.lostConnectionRetrySeconds)
    }

    func testDecisionsMatchTheVectors() throws {
        let v = try Self.vectors()
        let now = Date(timeIntervalSince1970: v.now)
        for c in v.decide {
            let decision = decideBusy(
                provider: v.providers[c.provider]!, status: c.status, headers: c.headers, body: Data(c.body.utf8),
                attempt: c.attempt, lane: c.lane, now: now, formatReset: Self.stubReset)
            let expected: BusyDecision
            switch c.expect.action {
            case "success": expected = .success
            case "return": expected = .returnResponse
            case "retry": expected = .retry(wait: c.expect.waitSeconds!)
            case "fail": expected = .fail(message: c.expect.message!, cooldown: c.expect.cooldownSeconds)
            default: return XCTFail("unknown action \(c.expect.action)")
            }
            XCTAssertEqual(decision, expected, c.name)
        }
    }

    func testMessagesMatchTheVectors() throws {
        let v = try Self.vectors()
        let now = Date(timeIntervalSince1970: v.now)
        for c in v.messages {
            let message = ProviderErrors.message(
                v.providers[c.provider]!, status: c.status, body: Data(c.body.utf8), headers: c.headers ?? [:],
                now: now, formatReset: Self.stubReset)
            XCTAssertEqual(message, c.expect)
        }
        let long = v.longDetail
        let body = try JSONSerialization.data(withJSONObject: ["error": ["message": String(repeating: long.repeat, count: long.count)]])
        let message = ProviderErrors.message(v.providers[long.provider]!, status: long.status, body: body)
        XCTAssertTrue(message.hasPrefix(long.expectPrefix))
        XCTAssertTrue(message.hasSuffix(long.expectSuffix))
        XCTAssertEqual(message.count - long.expectPrefix.count - long.expectSuffix.count, long.expectDetailLength)
    }

    func testCooldownsEndAndAreNeverCutShort() async {
        let cooldowns = BusyCooldowns()
        let start = Date(timeIntervalSince1970: 1000)
        await cooldowns.record("claude", seconds: 120, message: "long", now: start)
        await cooldowns.record("claude", seconds: 10, message: "short", now: start)
        let cooling = await cooldowns.get("claude", now: start)
        XCTAssertEqual(cooling?.remaining, 120)
        XCTAssertEqual(cooling?.message, "long")
        let ended = await cooldowns.get("claude", now: start.addingTimeInterval(121))
        XCTAssertNil(ended)
    }

    static let claude = BusyProvider(name: "Claude", credential: .subscription)
    static let rateLimit = #"{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}"#

    /// Answers with `replies` in order (the last one repeats) and counts the calls.
    final class Stub: @unchecked Sendable {
        let replies: [(Int, String)]
        var calls = 0
        init(_ replies: [(Int, String)]) { self.replies = replies }
        func send() -> (Data, URLResponse) {
            let (status, body) = replies[min(calls, replies.count - 1)]
            calls += 1
            let response = HTTPURLResponse(url: URL(string: "https://example.invalid")!, statusCode: status, httpVersion: nil, headerFields: [:])!
            return (Data(body.utf8), response)
        }
    }

    func testARateLimitIsAskedAgainBeforeItBecomesAnError() async throws {
        let stub = Stub([(429, Self.rateLimit), (200, "{}")])
        let (_, response) = try await sendRetryingWhenBusy(provider: Self.claude, cooldowns: BusyCooldowns(), wait: { _ in }) { stub.send() }
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(stub.calls, 2)
    }

    func testALastingRateLimitCoolsDownAndStopsTheNextRequest() async throws {
        let cooldowns = BusyCooldowns()
        let stub = Stub([(429, Self.rateLimit)])
        do {
            _ = try await sendRetryingWhenBusy(provider: Self.claude, cooldowns: cooldowns, wait: { _ in }) { stub.send() }
            XCTFail("expected ProviderBusyError")
        } catch let error as ProviderBusyError {
            XCTAssertEqual(error.message, "Claude has hit your account's rate limit for the moment. Try again in a minute.")
        }
        XCTAssertEqual(stub.calls, 3)
        do {
            _ = try await sendRetryingWhenBusy(provider: Self.claude, cooldowns: cooldowns, wait: { _ in }) { stub.send() }
            XCTFail("expected ProviderBusyError")
        } catch is ProviderBusyError {}
        XCTAssertEqual(stub.calls, 3, "the cooldown stops before the network")
    }

    func testARefusalComesBackAsTheResponse() async throws {
        let cooldowns = BusyCooldowns()
        let stub = Stub([(429, #"{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}"#)])
        let (_, response) = try await sendRetryingWhenBusy(provider: Self.claude, cooldowns: cooldowns, wait: { _ in }) { stub.send() }
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 429)
        XCTAssertEqual(stub.calls, 1)
        let cooling = await cooldowns.get("Claude")
        XCTAssertNil(cooling)
    }

    func testADroppedConnectionIsAskedAgain() async throws {
        var calls = 0
        let value: String = try await retryingLostConnection(delays: [0]) {
            calls += 1
            if calls == 1 { throw URLError(.networkConnectionLost) }
            return "ok"
        }
        XCTAssertEqual(value, "ok")
        XCTAssertFalse(isLostConnection(URLError(.timedOut)))
    }
}
