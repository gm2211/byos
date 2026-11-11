import Foundation

/// Foreground and background lanes for AI requests, so the person's own requests come first. The same
/// rules as @byos/core's request-pacer.ts; ported from Skim's CloudAIPacer. Background work runs one
/// request at a time (or `width` at once, for work that streams results the person is watching) and
/// waits while any foreground request is in flight, so a burst of background work can't fill a rate
/// limit just before the person asks for something. Cooldowns after a 429 live in `BusyCooldowns`.
public actor RequestPacer {
    public static let shared = RequestPacer()

    private var foregroundInFlight = 0
    private var backgroundInFlight = 0
    private var waiters: [(width: Int, continuation: CheckedContinuation<Void, Never>)] = []

    public init() {}

    /// Waits for a slot in `lane`. Pair every call with `finish(_:)`; `run` does both.
    public func start(_ lane: RequestLane, width: Int = 1) async {
        switch lane {
        case .foreground:
            foregroundInFlight += 1
        case .background:
            let width = max(1, width)
            if waiters.isEmpty, foregroundInFlight == 0, backgroundInFlight < width {
                backgroundInFlight += 1
                return
            }
            await withCheckedContinuation { waiters.append((width, $0)) }
        }
    }

    public func finish(_ lane: RequestLane) {
        switch lane {
        case .foreground: foregroundInFlight = max(0, foregroundInFlight - 1)
        case .background: backgroundInFlight = max(0, backgroundInFlight - 1)
        }
        resumeWaiting()
    }

    /// Runs `work` in `lane`, holding its slot until it returns or throws.
    public func run<T: Sendable>(_ lane: RequestLane, width: Int = 1, _ work: @Sendable () async throws -> T) async rethrows -> T {
        await start(lane, width: width)
        defer { finish(lane) }
        return try await work()
    }

    public var waitingInBackground: Int { waiters.count }
    public var inFlightInBackground: Int { backgroundInFlight }
    public var inFlightInForeground: Int { foregroundInFlight }

    /// Clears all state and lets every waiter go; for tests.
    public func reset() {
        foregroundInFlight = 0
        backgroundInFlight = 0
        let pending = waiters
        waiters = []
        pending.forEach { $0.continuation.resume() }
    }

    /// Starts waiting background requests in order while their width allows.
    private func resumeWaiting() {
        while foregroundInFlight == 0, let next = waiters.first, backgroundInFlight < next.width {
            waiters.removeFirst()
            backgroundInFlight += 1
            next.continuation.resume()
        }
    }
}
