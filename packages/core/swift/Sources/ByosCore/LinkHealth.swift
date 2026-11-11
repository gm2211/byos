import Foundation
#if canImport(Network)
import Network
#endif

/// When to give up waiting on the online model, the same rules as @byos/core's link-health.ts and the
/// vectors in conformance/link-health.json. Ported from Skim's SkimCore LinkHealth. A non-streamed
/// answer says nothing until it is done, so a slow answer and a dead link look the same from the
/// request; a TCP handshake with the provider's host (`LinkProbe`) tells them apart in one round trip.
/// One bad probe is not enough: the watch needs `strikes` bad probes in a row, and on a steady path
/// (Wi-Fi or wired, not Low Data Mode) only failed handshakes count, not slow ones.
public enum LinkHealth {
    public enum Verdict: String, Sendable, Equatable, Decodable { case healthy, degraded, down }

    /// Probe budget: a handshake that takes longer is as good as none.
    public static let probeTimeout: Duration = .milliseconds(2_500)
    /// A handshake slower than this is a link too poor to carry an answer soon (EDGE-class).
    public static let degradedRTT: Duration = .milliseconds(800)
    /// How often the link is checked again while an answer is pending.
    public static let reprobe: Duration = .seconds(3)
    /// How soon a bad probe is checked again, to confirm it.
    public static let confirmReprobe: Duration = .seconds(1)
    /// Bad probes in a row that make a bad link.
    public static let strikes = 2
    public static let minHedge: Duration = .seconds(5)
    /// A model that is slow every time earns a later deadline, up to this.
    public static let maxHedge: Duration = .seconds(30)
    /// The deadline until five answers are seen.
    public static let initialHedge: Duration = .seconds(12)
    /// A summary is two long completions, so it gets more room than a chat answer.
    public static let summaryMinHedge: Duration = .seconds(8)
    public static let summaryMaxHedge: Duration = .seconds(45)
    public static let summaryInitialHedge: Duration = .seconds(20)

    /// `rtt` nil means the handshake failed or timed out.
    public static func verdict(rtt: Duration?, slowRadio: Bool = false) -> Verdict {
        guard let rtt, rtt <= probeTimeout else { return .down }
        return rtt > degradedRTT || slowRadio ? .degraded : .healthy
    }

    /// How long a healthy link may stay silent: 1.25 times the 90th percentile of recent answers,
    /// within the bounds, so a model that always takes 20 s isn't raced every time; `initial` with
    /// fewer than 5 answers seen.
    public static func hedge(
        recent: [Duration],
        min lower: Duration = minHedge,
        max upper: Duration = maxHedge,
        initial: Duration = initialHedge
    ) -> Duration {
        guard recent.count >= 5 else { return initial }
        let sorted = recent.sorted()
        let p90 = sorted[Swift.min(sorted.count - 1, Int((Double(sorted.count) * 0.9).rounded(.up)) - 1)]
        return Swift.min(upper, Swift.max(lower, p90 * 1.25))
    }

    /// Whether one probe counts against the link. On a steady path a handshake that completes is good
    /// enough, however slow: only a failed one counts.
    public static func isBad(rtt: Duration?, slowRadio: Bool = false, steadyPath: Bool = false) -> Bool {
        switch verdict(rtt: rtt, slowRadio: slowRadio) {
        case .healthy: return false
        case .down: return true
        case .degraded: return !steadyPath
        }
    }

    /// Probes at once and then every `reprobe` until cancelled; true once `strikes` probes in a row
    /// count against the link. A bad probe is checked again after `confirmReprobe`.
    @MainActor
    public static func watch(
        probe: @escaping @MainActor () async -> Duration?,
        slowRadio: @escaping @MainActor () -> Bool = { false },
        steadyPath: @escaping @MainActor () -> Bool = { false },
        strikes needed: Int = strikes,
        reprobe every: Duration = reprobe,
        confirmReprobe confirm: Duration = confirmReprobe,
        sleep: @escaping @MainActor (Duration) async -> Void = { try? await Task.sleep(for: $0) }
    ) async -> Bool {
        var inARow = 0
        while !Task.isCancelled {
            let rtt = await probe()
            if Task.isCancelled { return false }
            inARow = isBad(rtt: rtt, slowRadio: slowRadio(), steadyPath: steadyPath()) ? inARow + 1 : 0
            if inARow >= needed { return true }
            await sleep(inARow > 0 ? confirm : every)
        }
        return false
    }
}

#if canImport(Network)
/// A TCP handshake with a provider's host, to tell a dead or poor link from a slow model.
public enum LinkProbe {
    /// How long a fresh TCP handshake with `host` takes; nil when it fails or outlasts `timeout`.
    public static func handshakeRTT(host: String, port: UInt16 = 443, timeout: Duration = LinkHealth.probeTimeout) async -> Duration? {
        let connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port) ?? 443, using: .tcp)
        let clock = ContinuousClock()
        let started = clock.now
        let once = Once()
        return await withCheckedContinuation { (continuation: CheckedContinuation<Duration?, Never>) in
            let finish: @Sendable (Duration?) -> Void = { value in
                guard once.claim() else { return }
                connection.cancel()
                continuation.resume(returning: value)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(clock.now - started)
                case .failed, .cancelled, .waiting: finish(nil)
                default: break
                }
            }
            connection.start(queue: DispatchQueue(label: "byos.link-probe"))
            let (seconds, attoseconds) = timeout.components
            let nanoseconds = Int(seconds) * 1_000_000_000 + Int(attoseconds / 1_000_000_000)
            DispatchQueue.global().asyncAfter(deadline: .now() + .nanoseconds(nanoseconds)) { finish(nil) }
        }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func claim() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if done { return false }
            done = true
            return true
        }
    }
}
#endif

/// Falling back to an on-device model when the connection is really gone, the same rules as
/// @byos/core's runWithOfflineFallback. Ported from Skim's OfflineAIFallback.
public enum OfflineFallback {
    /// Which model a request is for: `auto` falls back only when offline; `online` never falls back
    /// (the caller does); `local` always uses the on-device stand-in.
    public enum Route: String, Sendable, Decodable { case auto, online, local }

    /// A host on the device's own network (loopback, .local, private IPv4), which needs no internet.
    public static func isLocalNetworkHost(_ host: String) -> Bool {
        var host = host.lowercased()
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host == "localhost" || host.hasSuffix(".local") || host.hasPrefix("127.") || host == "::1" {
            return true
        }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ (1...3).contains($0.count) && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }) else { return false }
        let a = Int(parts[0]) ?? -1, b = Int(parts[1]) ?? -1
        return a == 10 || (a == 192 && b == 168) || (a == 172 && (16...31).contains(b)) || (a == 169 && b == 254)
    }

    /// A failure that means the request never reached the provider.
    public static func isConnectivityError(_ error: Error) -> Bool {
        matches(error, [
            .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost,
            .dnsLookupFailed, .timedOut, .dataNotAllowed, .internationalRoamingOff, .callIsActive,
        ])
    }

    /// A failure the system itself attributes to having no connection at all: nothing to probe.
    public static func isNoConnectionError(_ error: Error) -> Bool {
        matches(error, [.notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .callIsActive])
    }

    private static func matches(_ error: Error, _ codes: Set<URLError.Code>) -> Bool {
        if let urlError = error as? URLError { return codes.contains(urlError.code) }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain { return codes.contains(URLError.Code(rawValue: nsError.code)) }
        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? Error { return matches(underlying, codes) }
        return false
    }

    /// The sentence for a timeout or dropped request on a link that still answers a handshake.
    public static func providerFailureMessage(providerName: String, timedOut: Bool, reason: String? = nil) -> String {
        if timedOut { return "\(providerName) took too long to answer. Your connection is fine; try again." }
        return "\(providerName) didn't answer\(reason.map { " (\($0))" } ?? ""). Your connection is fine; try again."
    }

    /// A request that failed on a healthy link; `message` is safe to show.
    public struct ProviderFailure: LocalizedError, Equatable, Sendable {
        public let message: String
        public init(message: String) { self.message = message }
        public var errorDescription: String? { message }
    }

    /// Runs `request` on the provider in effect, and once more on the on-device model when a cloud
    /// request fails for want of a connection the system had not noticed was gone. A timeout or
    /// dropped request counts as a lost connection only when the provider's link no longer answers a
    /// probe; on a healthy link it is thrown as `providerFailure`, so a slow provider never looks like
    /// being offline.
    public static func run<S, T>(
        _ settings: S,
        route: Route = .auto,
        offline: Bool,
        needsConnection: (S) -> Bool,
        reroute: (S) -> S?,
        linkHealthy: (S) async -> Bool,
        isConnectivityError: (Error) -> Bool = OfflineFallback.isConnectivityError,
        isNoConnectionError: (Error) -> Bool = OfflineFallback.isNoConnectionError,
        onUnreachable: () -> Void = {},
        providerFailure: (Error, S) -> Error,
        _ request: (S) async throws -> T
    ) async throws -> T {
        var effective = settings
        if route != .online, offline || route == .local, needsConnection(settings), let local = reroute(settings) {
            effective = local
        }
        do {
            return try await request(effective)
        } catch {
            guard route != .local, needsConnection(effective), isConnectivityError(error) else { throw error }
            if !isNoConnectionError(error), await linkHealthy(effective) {
                throw providerFailure(error, effective)
            }
            if route == .online {
                onUnreachable()
                throw error
            }
            guard let local = reroute(effective) else { throw error }
            onUnreachable()
            return try await request(local)
        }
    }
}
