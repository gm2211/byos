import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Busy providers, rate limits and the messages people see when a request fails; mirrors
/// `provider-busy.ts` in @byos/core and runs the same vectors (../conformance/provider-busy.json).
///
/// A 429 or overloaded answer is asked again after a short wait (honouring `retry-after` and Claude's
/// `anthropic-ratelimit-unified-*` plan-window headers) before it becomes an error. A rate limit that
/// outlasts the retries starts a cooldown: until it ends, requests to that provider stop at once with
/// the same plain message. Background work is never retried. Every other failure gets one sentence a
/// person can act on (`ProviderErrors.message`); raw JSON error bodies never reach the UI.
public enum BusyPolicy {
    public static let busyStatuses: Set<Int> = [429, 503, 529]
    public static let backoff: [TimeInterval] = [2, 6]
    /// Longest wait a foreground request sits through before asking again.
    public static let waitLimit: TimeInterval = 20
    /// Cooldown after a 429 that does not say how long to wait.
    public static let defaultCooldown: TimeInterval = 60
    /// A reset further out than this reads as a plan limit with a time.
    public static let planLimitMessageAfter: TimeInterval = 15 * 60
    public static let lostConnectionRetryDelays: [TimeInterval] = [0.5, 2]
}

/// Who failed, for the message: the name people know and how they connected.
public struct BusyProvider: Equatable, Sendable, Decodable {
    public var name: String
    public var credential: CredentialKind
    /// Added after a plan-limit message, e.g. "Claude.ai and Claude Code count toward the same limit."
    public var sharedLimitNote: String?

    public init(name: String, credential: CredentialKind, sharedLimitNote: String? = nil) {
        self.name = name
        self.credential = credential
        self.sharedLimitNote = sharedLimitNote
    }
}

/// `foreground`: someone is waiting on it. `background`: prefetch and batch work; never retried.
public enum RequestLane: String, Sendable, Decodable {
    case foreground
    case background
}

/// What a 429 or overloaded response says about when to ask again.
public struct BusySignal: Equatable, Sendable {
    public var retryAfter: TimeInterval?
    /// When the plan's usage window reopens (Claude sign-in).
    public var resetsAt: Date?
    /// The plan's window is closed, rather than the requests being too fast.
    public var planLimitReached: Bool

    public init(retryAfter: TimeInterval? = nil, resetsAt: Date? = nil, planLimitReached: Bool = false) {
        self.retryAfter = retryAfter
        self.resetsAt = resetsAt
        self.planLimitReached = planLimitReached
    }

    /// Reads `retry-after` and Claude's `anthropic-ratelimit-unified-*` headers. Header names match
    /// in any case.
    public init(headers: [String: String], now: Date = Date()) {
        func header(_ name: String) -> String? {
            headers.first { $0.key.lowercased() == name }?.value.trimmingCharacters(in: .whitespaces)
        }
        retryAfter = header("retry-after").flatMap(TimeInterval.init).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        resetsAt = header("anthropic-ratelimit-unified-reset").flatMap(TimeInterval.init)
            .map { Date(timeIntervalSince1970: $0) }
            .flatMap { $0 > now ? $0 : nil }
        planLimitReached = header("anthropic-ratelimit-unified-status")?.lowercased() == "rejected"
    }

    public init(response: HTTPURLResponse, now: Date = Date()) {
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            if let key = key as? String, let value = value as? String { headers[key] = value }
        }
        self.init(headers: headers, now: now)
    }

    /// Seconds to wait before asking again, when the provider said.
    public func wait(now: Date = Date()) -> TimeInterval? {
        let untilReset = resetsAt.map { max(0, $0.timeIntervalSince(now)) }
        if planLimitReached, let untilReset { return untilReset }
        return retryAfter ?? untilReset
    }
}

/// Formats when a plan window reopens, as the words after "It resets": "at 3:00 PM", "on Monday at 3:00 PM".
public typealias ResetFormatter = @Sendable (_ resetsAt: Date, _ now: Date) -> String

public enum ProviderErrors {
    public static let formatReset: ResetFormatter = { resetsAt, now in
        let time = DateFormatter.localizedString(from: resetsAt, dateStyle: .none, timeStyle: .short)
        if Calendar.current.isDate(resetsAt, inSameDayAs: now) { return "at \(time)" }
        let weekday = DateFormatter()
        weekday.setLocalizedDateFormatFromTemplate("EEEE")
        return "on \(weekday.string(from: resetsAt)) at \(time)"
    }

    /// The `error` of a failure body: `{"error":{"type","message"}}` (Anthropic, OpenAI-compatible)
    /// or `{"error":"..."}` (xAI).
    public static func envelope(_ body: Data) -> (type: String?, message: String?) {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return (nil, nil) }
        if let message = object["error"] as? String { return (nil, message) }
        guard let error = object["error"] as? [String: Any] else { return (nil, nil) }
        return (error["type"] as? String, error["message"] as? String)
    }

    /// False for placeholders such as Claude's bare "Error" that would read as broken.
    public static func isInformative(_ detail: String?) -> Bool {
        guard let trimmed = detail?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return trimmed.count > 10 && trimmed.lowercased() != "error"
    }

    static func informativeDetail(_ body: Data) -> String? {
        let message = envelope(body).message?.trimmingCharacters(in: .whitespacesAndNewlines)
        return isInformative(message) ? message : nil
    }

    static func clip(_ text: String, _ length: Int) -> String {
        text.count > length ? String(text.prefix(length)) + "…" : text
    }

    /// A 429 that says nothing about a limit: no `retry-after`, no usage window, and only a
    /// placeholder message. Claude turns the request itself down this way; asking again gets the
    /// same answer, and no cooldown should start.
    public static func isRefusal429(_ body: Data, signal: BusySignal) -> Bool {
        informativeDetail(body) == nil && signal.retryAfter == nil && signal.resetsAt == nil && !signal.planLimitReached
    }

    /// The message for a real rate limit: when it lifts if the provider said, never its boilerplate.
    public static func rateLimitMessage(
        _ provider: BusyProvider, body: Data, signal: BusySignal, now: Date = Date(), formatReset: ResetFormatter = ProviderErrors.formatReset
    ) -> String {
        let wait = signal.wait(now: now)
        if let resetsAt = signal.resetsAt, signal.planLimitReached || (wait ?? 0) > BusyPolicy.planLimitMessageAfter {
            let note = provider.sharedLimitNote.map { " \($0)" } ?? ""
            return "You've reached your \(provider.name) plan's usage limit. It resets \(formatReset(resetsAt, now)).\(note)"
        }
        var message: String
        if let wait, wait > 0 {
            let minutes = max(1, Int((wait / 60).rounded(.up)))
            message = "\(provider.name) has hit your account's rate limit. Try again in \(minutes == 1 ? "a minute" : "\(minutes) minutes")."
        } else {
            message = "\(provider.name) has hit your account's rate limit for the moment. Try again in a minute."
        }
        if let detail = informativeDetail(body), !detail.lowercased().contains("would exceed your account's rate limit") {
            message += " (\(clip(detail, 160)))"
        }
        return message
    }

    public static func overloaded(_ provider: BusyProvider) -> String {
        "\(provider.name) is overloaded right now. Try again in a minute."
    }

    public static func emptyResponse(_ provider: BusyProvider) -> String {
        "\(provider.name) sent back an empty answer. Try again."
    }

    /// One sentence a person can act on for a failed provider request. Reads the provider's error
    /// envelope where there is one; never returns the raw body.
    public static func message(
        _ provider: BusyProvider, status: Int, body: Data, headers: [String: String] = [:],
        now: Date = Date(), formatReset: ResetFormatter = ProviderErrors.formatReset
    ) -> String {
        let name = provider.name
        let unavailable = "\(name) is temporarily unavailable. Try again shortly."
        switch status {
        case 401:
            return provider.credential == .subscription
                ? "\(name) sign-in expired. Sign in again in Settings."
                : "\(name) rejected the API key. Check it in Settings."
        case 402, 403:
            return "Your \(name) plan doesn't allow this request."
        case 429:
            let signal = BusySignal(headers: headers, now: now)
            if isRefusal429(body, signal: signal) {
                let next = provider.credential == .subscription ? "sign in to \(name) again in Settings" : "check your account in Settings"
                return "\(name) turned down this request without saying why (429). Try another model, or \(next)."
            }
            return rateLimitMessage(provider, body: body, signal: signal, now: now, formatReset: formatReset)
        case 500...599:
            return unavailable
        default:
            let (type, message) = envelope(body)
            if type == "overloaded_error" { return unavailable }
            if let detail = message?.trimmingCharacters(in: .whitespacesAndNewlines), isInformative(detail) {
                return "\(name) couldn't run this request: \(clip(detail, 240))"
            }
            return "\(name) request failed (\(status)). Try again."
        }
    }
}

/// What to do with one response. `fail` carries the message to show and, for a rate limit, the cooldown.
public enum BusyDecision: Equatable, Sendable {
    case success
    case returnResponse
    case retry(wait: TimeInterval)
    case fail(message: String, cooldown: TimeInterval?)
}

/// The retry rule, without any I/O, so every platform makes the same call. `attempt` counts the
/// retries already made for this request, from 0.
public func decideBusy(
    provider: BusyProvider, status: Int, headers: [String: String], body: Data, attempt: Int,
    lane: RequestLane = .foreground, now: Date = Date(), formatReset: ResetFormatter = ProviderErrors.formatReset
) -> BusyDecision {
    if (200..<300).contains(status) { return .success }
    guard BusyPolicy.busyStatuses.contains(status) else { return .returnResponse }
    let signal = BusySignal(headers: headers, now: now)
    if status == 429, ProviderErrors.isRefusal429(body, signal: signal) { return .returnResponse }
    let wait = signal.wait(now: now)
    let backoff = lane == .foreground ? BusyPolicy.backoff : []
    if attempt < backoff.count, !signal.planLimitReached, (wait ?? 0) <= BusyPolicy.waitLimit {
        return .retry(wait: max(wait ?? 0, backoff[attempt]))
    }
    if status == 429 {
        let message = ProviderErrors.rateLimitMessage(provider, body: body, signal: signal, now: now, formatReset: formatReset)
        return .fail(message: message, cooldown: wait ?? BusyPolicy.defaultCooldown)
    }
    return .fail(message: ProviderErrors.overloaded(provider), cooldown: nil)
}

/// Per-provider cooldowns. One app-wide instance (`shared`) unless tests need their own.
public actor BusyCooldowns {
    public static let shared = BusyCooldowns()

    private var limits: [String: (until: Date, message: String)] = [:]

    public init() {}

    /// Seconds left on `key`'s cooldown and the message it ended with.
    public func get(_ key: String, now: Date = Date()) -> (remaining: TimeInterval, message: String)? {
        guard let limit = limits[key] else { return nil }
        guard limit.until > now else {
            limits[key] = nil
            return nil
        }
        return (limit.until.timeIntervalSince(now), limit.message)
    }

    /// Starts or extends a cooldown; a shorter one never cuts a longer one short.
    public func record(_ key: String, seconds: TimeInterval, message: String, now: Date = Date()) {
        let until = now.addingTimeInterval(seconds)
        if let existing = limits[key], existing.until >= until { return }
        limits[key] = (until, message)
    }

    public func clear(_ key: String) {
        limits[key] = nil
    }
}

/// Thrown when a provider stays busy past the retries, or is cooling down. The message is safe to show.
public struct ProviderBusyError: LocalizedError, Equatable, Sendable {
    public let message: String
    public let retryAfter: TimeInterval?
    public init(message: String, retryAfter: TimeInterval?) {
        self.message = message
        self.retryAfter = retryAfter
    }
    public var errorDescription: String? { message }
}

/// True when `error` is a dropped connection, which a fresh connection usually fixes.
public func isLostConnection(_ error: Error) -> Bool {
    if let urlError = error as? URLError { return urlError.code == .networkConnectionLost }
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain { return nsError.code == URLError.Code.networkConnectionLost.rawValue }
    if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? Error { return isLostConnection(underlying) }
    return false
}

/// Sleeps `seconds` (none for zero or less); throws when the task is cancelled.
public func busySleep(_ seconds: TimeInterval) async throws {
    guard seconds > 0 else { return }
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
}

/// Runs `send`, and again (after `delays`) while it fails because the connection dropped. Any other
/// failure, and the last drop, is thrown as it came.
public func retryingLostConnection<T>(
    delays: [TimeInterval] = BusyPolicy.lostConnectionRetryDelays,
    isLost: (Error) -> Bool = isLostConnection,
    _ send: () async throws -> T
) async throws -> T {
    var attempt = 0
    while true {
        do {
            return try await send()
        } catch {
            guard isLost(error), attempt < delays.count, !Task.isCancelled else { throw error }
            try await busySleep(delays[attempt])
            attempt += 1
        }
    }
}

/// Sends through the busy rules: waits out a short cooldown (foreground only), asks again when the
/// provider is busy, and starts a cooldown when a rate limit outlasts the retries. Returns the
/// response for success and for any failure that is not busy (build its message with
/// `ProviderErrors.message`); throws `ProviderBusyError` when the provider stays busy.
public func sendRetryingWhenBusy(
    provider: BusyProvider,
    key: String? = nil,
    lane: RequestLane = .foreground,
    cooldowns: BusyCooldowns = .shared,
    wait: @escaping (TimeInterval) async throws -> Void = busySleep,
    _ send: () async throws -> (Data, URLResponse)
) async throws -> (Data, URLResponse) {
    let key = key ?? provider.name
    if let cooling = await cooldowns.get(key) {
        if lane == .background || cooling.remaining > BusyPolicy.waitLimit {
            throw ProviderBusyError(message: cooling.message, retryAfter: cooling.remaining)
        }
        try await wait(cooling.remaining)
    }
    var attempt = 0
    while true {
        try Task.checkCancellation()
        let (data, response) = try await retryingLostConnection(send)
        guard let http = response as? HTTPURLResponse else { return (data, response) }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String { headers[name] = value }
        }
        switch decideBusy(provider: provider, status: http.statusCode, headers: headers, body: data, attempt: attempt, lane: lane) {
        case .success:
            await cooldowns.clear(key)
            return (data, response)
        case .returnResponse:
            return (data, response)
        case .retry(let seconds):
            try await wait(seconds)
            attempt += 1
        case .fail(let message, let cooldown):
            if let cooldown { await cooldowns.record(key, seconds: cooldown, message: message) }
            throw ProviderBusyError(message: message, retryAfter: cooldown)
        }
    }
}

/// `sendRetryingWhenBusy` for a `URLRequest` on `session`.
public func sendRetryingWhenBusy(
    _ request: URLRequest,
    session: URLSession = .shared,
    provider: BusyProvider,
    key: String? = nil,
    lane: RequestLane = .foreground,
    cooldowns: BusyCooldowns = .shared
) async throws -> (Data, URLResponse) {
    try await sendRetryingWhenBusy(provider: provider, key: key, lane: lane, cooldowns: cooldowns) {
        try await session.data(for: request)
    }
}
