import Foundation

/// Claude Messages request shaping, the same rules as @byos/core's claude-request.ts and the vectors in
/// conformance/request-shaping.json. Ported from Skim (provider.rs, NativeAI.swift).
public enum ClaudeRequest {
    /// Smallest `max_tokens` sent to a model that thinks, so thinking can't use the whole budget.
    public static let thinkingMaxTokensFloor = 4096
    /// Temperature sent to models that take one when the caller doesn't choose.
    public static let defaultTemperature = 0.2

    /// Major/minor version from a Claude model id, or nil for an id that isn't one.
    /// "claude-3-5-sonnet-…" names the version first; "claude-sonnet-4-6" the family first.
    /// A 1-2 digit second part is the minor version; a date snapshot ("4-20250514") is x.0.
    public static func modelVersion(_ model: String) -> (major: Int, minor: Int)? {
        var parts = model.lowercased().split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.first == "claude" else { return nil }
        parts.removeFirst()
        if let first = parts.first, !isDigits(first) { parts.removeFirst() }
        guard let majorText = parts.first, isDigits(majorText), let major = Int(majorText) else { return nil }
        let next = parts.dropFirst().first
        let minor = next.flatMap { $0.count <= 2 && isDigits($0) ? Int($0) : nil } ?? 0
        return (major, minor)
    }

    /// Claude Opus/Sonnet 4.7 and later, and every 5-series model, answer a `temperature` field with a
    /// 400. True only for Claude 3.x and 4.0-4.6; an unrecognised model gets the API's default sampling.
    public static func acceptsTemperature(_ model: String) -> Bool {
        guard let version = modelVersion(model) else { return false }
        return version.major < 4 || (version.major == 4 && version.minor <= 6)
    }

    /// Every 5-series model thinks before answering unless told otherwise and takes
    /// `output_config.effort`. Older models think only when asked, and some reject `effort`.
    public static func thinksByDefault(_ model: String) -> Bool {
        (modelVersion(model)?.major ?? 0) >= 5
    }

    /// The `system` field: a plain string for an API key; for a subscription token, the Claude Code
    /// identity line as its own first block, then the app's instructions. Without that line Anthropic
    /// answers a subscription request with a bare 429 "Error".
    public static func system(instructions: String, subscription: Bool) -> Any {
        guard subscription else { return instructions }
        var blocks: [[String: Any]] = [["type": "text", "text": ClaudeOAuth.claudeCodeSystemPrefix]]
        if !instructions.isEmpty { blocks.append(["type": "text", "text": instructions]) }
        return blocks
    }

    /// The Messages API body. Temperature only where accepted (and never with thinking); a chosen
    /// `effort` turns on adaptive thinking at that effort; without one, a model that thinks by default
    /// gets low effort. Either way thinking gets at least `thinkingMaxTokensFloor`, so the answer isn't
    /// empty because the budget went on thinking.
    public static func body(
        model: String,
        messages: [[String: Any]],
        instructions: String = "",
        subscription: Bool,
        maxTokens: Int,
        temperature: Double? = nil,
        effort: String? = nil,
        stream: Bool = false,
        tools: [[String: Any]]? = nil
    ) -> [String: Any] {
        var body: [String: Any] = [
            "model": model,
            "system": system(instructions: instructions, subscription: subscription),
            "messages": messages,
            "max_tokens": maxTokens,
        ]
        if stream { body["stream"] = true }
        if acceptsTemperature(model), effort == nil { body["temperature"] = temperature ?? defaultTemperature }
        if let effort {
            body["thinking"] = ["type": "adaptive"]
            body["output_config"] = ["effort": effort]
        } else if thinksByDefault(model) {
            body["output_config"] = ["effort": "low"]
        }
        if effort != nil || thinksByDefault(model) { body["max_tokens"] = max(maxTokens, thinkingMaxTokensFloor) }
        if let tools, !tools.isEmpty { body["tools"] = tools }
        return body
    }

    /// What to tell the reader when a response carries no text, by `stop_reason`.
    public static func emptyResponseMessage(stopReason: String?) -> String {
        switch stopReason {
        case "max_tokens": return "Claude ran out of room before it wrote an answer. Try again, or ask a narrower question."
        case "refusal": return "Claude declined to answer this. Try rephrasing the question."
        default: return "The Claude response was empty."
        }
    }

    private static func isDigits(_ text: String) -> Bool {
        !text.isEmpty && text.allSatisfy { $0.isASCII && $0.isNumber }
    }
}
