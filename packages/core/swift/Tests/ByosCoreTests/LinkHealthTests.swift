import Foundation
import XCTest
@testable import ByosCore

/// Runs the vectors @byos/core's TypeScript tests use (conformance/link-health.json).
final class LinkHealthTests: XCTestCase {
    struct Bounds: Decodable {
        let min: Int
        let max: Int
        let initial: Int
    }
    struct Policy: Decodable {
        let probeTimeoutMs: Int
        let degradedRttMs: Int
        let reprobeMs: Int
        let confirmReprobeMs: Int
        let strikes: Int
        let chatHedge: Bounds
        let summaryHedge: Bounds
    }
    struct VerdictCase: Decodable {
        let rttMs: Int?
        let slowRadio: Bool
        let expect: LinkHealth.Verdict
    }
    struct BadCase: Decodable {
        let rttMs: Int?
        let slowRadio: Bool
        let steadyPath: Bool
        let expect: Bool
    }
    struct HedgeCase: Decodable {
        let name: String
        let recentMs: [Int]
        let bounds: String
        let expect: Int
    }
    struct WatchCase: Decodable {
        let name: String
        let probesMs: [Int?]
        let steadyPath: Bool
        let expect: Bool
        let probes: Int
        let waitsMs: [Int]
    }
    struct HostCase: Decodable {
        let host: String
        let expect: Bool
    }
    struct FailureCase: Decodable {
        let provider: String
        let timedOut: Bool
        let reason: String?
        let expect: String
    }
    struct FallbackCase: Decodable {
        struct Expect: Decodable {
            let ranOn: [String]
            let result: String?
            let error: String?
            let unreachable: Bool
        }
        let name: String
        let route: OfflineFallback.Route
        let offline: Bool
        let needsConnection: Bool
        let canReroute: Bool
        let fails: [String]
        let linkHealthy: Bool
        let expect: Expect
    }
    struct Vectors: Decodable {
        let policy: Policy
        let verdicts: [VerdictCase]
        let badProbes: [BadCase]
        let hedges: [HedgeCase]
        let watches: [WatchCase]
        let localHosts: [HostCase]
        let providerFailures: [FailureCase]
        let fallbacks: [FallbackCase]
    }

    static func vectors() throws -> Vectors {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/link-health.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    static func duration(_ value: Int?) -> Duration? { value.map { .milliseconds($0) } }
    static func ms(_ duration: Duration) -> Int {
        let (seconds, attoseconds) = duration.components
        return Int(seconds) * 1000 + Int((Double(attoseconds) / 1e15).rounded())
    }

    func testPolicyMatchesTheVectors() throws {
        let p = try Self.vectors().policy
        XCTAssertEqual(Self.ms(LinkHealth.probeTimeout), p.probeTimeoutMs)
        XCTAssertEqual(Self.ms(LinkHealth.degradedRTT), p.degradedRttMs)
        XCTAssertEqual(Self.ms(LinkHealth.reprobe), p.reprobeMs)
        XCTAssertEqual(Self.ms(LinkHealth.confirmReprobe), p.confirmReprobeMs)
        XCTAssertEqual(LinkHealth.strikes, p.strikes)
        XCTAssertEqual([LinkHealth.minHedge, LinkHealth.maxHedge, LinkHealth.initialHedge].map { Self.ms($0) }, [p.chatHedge.min, p.chatHedge.max, p.chatHedge.initial])
        XCTAssertEqual([LinkHealth.summaryMinHedge, LinkHealth.summaryMaxHedge, LinkHealth.summaryInitialHedge].map { Self.ms($0) }, [p.summaryHedge.min, p.summaryHedge.max, p.summaryHedge.initial])
    }

    func testVerdictsAndBadProbes() throws {
        let v = try Self.vectors()
        for c in v.verdicts {
            XCTAssertEqual(LinkHealth.verdict(rtt: Self.duration(c.rttMs), slowRadio: c.slowRadio), c.expect, "\(c.rttMs ?? -1)")
        }
        for c in v.badProbes {
            XCTAssertEqual(LinkHealth.isBad(rtt: Self.duration(c.rttMs), slowRadio: c.slowRadio, steadyPath: c.steadyPath), c.expect, "\(c.rttMs ?? -1)")
        }
    }

    func testHedges() throws {
        for c in try Self.vectors().hedges {
            let recent = c.recentMs.map { Duration.milliseconds($0) }
            let hedge = c.bounds == "summary"
                ? LinkHealth.hedge(recent: recent, min: LinkHealth.summaryMinHedge, max: LinkHealth.summaryMaxHedge, initial: LinkHealth.summaryInitialHedge)
                : LinkHealth.hedge(recent: recent)
            XCTAssertEqual(Self.ms(hedge), c.expect, c.name)
        }
    }

    @MainActor
    final class WatchLog {
        var probes = 0
        var waits: [Int] = []
    }

    @MainActor
    func testWatches() async throws {
        for c in try Self.vectors().watches {
            let log = WatchLog()
            let probesMs = c.probesMs
            let steady = c.steadyPath
            // The watch runs until its task is cancelled; the stub sleep cancels it once the scripted
            // probes are used up.
            let task = Task { @MainActor in
                await LinkHealth.watch(
                    probe: {
                        defer { log.probes += 1 }
                        return log.probes < probesMs.count ? LinkHealthTests.duration(probesMs[log.probes]) : nil
                    },
                    steadyPath: { steady },
                    sleep: { duration in
                        log.waits.append(LinkHealthTests.ms(duration))
                        if log.probes >= probesMs.count { withUnsafeCurrentTask { $0?.cancel() } }
                    }
                )
            }
            let result = await task.value
            XCTAssertEqual(result, c.expect, c.name)
            XCTAssertEqual(log.probes, c.probes, c.name)
            XCTAssertEqual(log.waits, c.waitsMs, c.name)
        }
    }

    func testLocalNetworkHosts() throws {
        for c in try Self.vectors().localHosts {
            XCTAssertEqual(OfflineFallback.isLocalNetworkHost(c.host), c.expect, c.host)
        }
    }

    func testProviderFailureSentences() throws {
        for c in try Self.vectors().providerFailures {
            XCTAssertEqual(OfflineFallback.providerFailureMessage(providerName: c.provider, timedOut: c.timedOut, reason: c.reason), c.expect)
        }
    }

    func testConnectivityErrors() {
        XCTAssertTrue(OfflineFallback.isConnectivityError(URLError(.timedOut)))
        XCTAssertTrue(OfflineFallback.isConnectivityError(NSError(domain: "x", code: 1, userInfo: [NSUnderlyingErrorKey: URLError(.cannotFindHost)])))
        XCTAssertFalse(OfflineFallback.isConnectivityError(URLError(.badServerResponse)))
        XCTAssertTrue(OfflineFallback.isNoConnectionError(URLError(.notConnectedToInternet)))
        XCTAssertFalse(OfflineFallback.isNoConnectionError(URLError(.timedOut)))
    }

    struct Failure: Error {
        let kind: String
    }

    func testFallbacksMatchTheVectors() async throws {
        for c in try Self.vectors().fallbacks {
            var ranOn: [String] = []
            var unreachable = false
            do {
                let result = try await OfflineFallback.run(
                    "cloud",
                    route: c.route,
                    offline: c.offline,
                    needsConnection: { $0 == "cloud" && c.needsConnection },
                    reroute: { _ in c.canReroute ? "device" : nil },
                    linkHealthy: { _ in c.linkHealthy },
                    isConnectivityError: { ($0 as? Failure).map { ["connectivity", "no-connection"].contains($0.kind) } ?? false },
                    isNoConnectionError: { ($0 as? Failure)?.kind == "no-connection" },
                    onUnreachable: { unreachable = true },
                    providerFailure: { _, _ in OfflineFallback.ProviderFailure(message: "provider") }
                ) { (s: String) async throws -> String in
                    ranOn.append(s)
                    if let failure = c.fails.first(where: { $0.hasPrefix(s + ":") }) {
                        throw Failure(kind: String(failure.split(separator: ":")[1]))
                    }
                    return s
                }
                XCTAssertEqual(result, c.expect.result, c.name)
            } catch is OfflineFallback.ProviderFailure {
                XCTAssertEqual(c.expect.error, "provider", c.name)
            } catch is Failure {
                XCTAssertEqual(c.expect.error, "original", c.name)
            }
            XCTAssertEqual(ranOn, c.expect.ranOn, c.name)
            XCTAssertEqual(unreachable, c.expect.unreachable, c.name)
        }
    }
}
