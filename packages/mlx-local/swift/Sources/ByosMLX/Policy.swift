import Foundation

// Model-family rules, sampling presets and template checks, ported from
// Skim's SkimInferencePolicy so BYOS runs the same models the same way.

public enum ModelFamily: String, Sendable {
    case gemma, gemma4, llama, qwen, phi, smol, lfm, unknown

    /// Stop strings that end a turn. The engine stops on them; the client
    /// strips any that reach the stream.
    public var stopStrings: [String] {
        switch self {
        case .gemma: return ["<end_of_turn>", "<eos>"]
        case .gemma4: return ["<turn|>", "<eos>"]
        case .llama: return ["<|eot_id|>", "<|end_of_text|>"]
        case .qwen, .smol, .lfm: return ["<|im_end|>", "<|endoftext|>"]
        case .phi: return ["<|end|>", "<|endoftext|>"]
        case .unknown: return []
        }
    }

    /// Families whose chat template honours `enable_thinking: false`.
    public var supportsThinkingToggle: Bool {
        switch self {
        case .qwen, .smol, .gemma4: return true
        default: return false
        }
    }

    public static func detect(from repoId: String) -> ModelFamily {
        let lower = repoId.lowercased()
        if lower.contains("smollm") { return .smol }
        if lower.contains("lfm2") { return .lfm }
        if lower.contains("gemma-4") || lower.contains("gemma4") { return .gemma4 }
        if lower.contains("gemma") { return .gemma }
        if lower.contains("llama") { return .llama }
        if lower.contains("qwen") { return .qwen }
        if lower.contains("phi") { return .phi }
        return .unknown
    }
}

public struct SamplingPreset: Sendable, Equatable {
    public var temperature: Float
    public var topP: Float
    public var repetitionPenalty: Float
    public var repetitionContextSize: Int

    /// Skim's chat-eval tuned values; everything else gets `fallback`.
    static let presets: [String: SamplingPreset] = [
        "mlx-community/gemma-3-1b-it-4bit": .init(temperature: 0.3, topP: 0.95, repetitionPenalty: 1.15, repetitionContextSize: 64),
        "mlx-community/gemma-3-4b-it-4bit": .init(temperature: 0.35, topP: 0.95, repetitionPenalty: 1.1, repetitionContextSize: 64),
        "mlx-community/Llama-3.2-1B-Instruct-4bit": .init(temperature: 0.3, topP: 0.9, repetitionPenalty: 1.15, repetitionContextSize: 64),
        "mlx-community/Llama-3.2-3B-Instruct-4bit": .init(temperature: 0.3, topP: 0.9, repetitionPenalty: 1.1, repetitionContextSize: 64),
        "mlx-community/Qwen3-1.7B-4bit": .init(temperature: 0.3, topP: 0.9, repetitionPenalty: 1.1, repetitionContextSize: 64),
        "mlx-community/Qwen3-4B-Instruct-2507-4bit": .init(temperature: 0.3, topP: 0.9, repetitionPenalty: 1.05, repetitionContextSize: 64),
        "mlx-community/Qwen3-8B-4bit": .init(temperature: 0.3, topP: 0.9, repetitionPenalty: 1.05, repetitionContextSize: 64),
        "mlx-community/Qwen3.5-2B-4bit": .init(temperature: 0.3, topP: 0.9, repetitionPenalty: 1.05, repetitionContextSize: 64),
        "mlx-community/Qwen3.5-4B-4bit": .init(temperature: 0.3, topP: 0.9, repetitionPenalty: 1.05, repetitionContextSize: 64),
        "mlx-community/Qwen3.5-9B-4bit": .init(temperature: 0.3, topP: 0.9, repetitionPenalty: 1.05, repetitionContextSize: 64),
        "mlx-community/LFM2.5-1.2B-Instruct-4bit": .init(temperature: 0.2, topP: 0.9, repetitionPenalty: 1.05, repetitionContextSize: 64),
        "mlx-community/gemma-4-e2b-it-4bit": .init(temperature: 0.3, topP: 0.95, repetitionPenalty: 1.05, repetitionContextSize: 64),
        "mlx-community/gemma-4-e4b-it-4bit": .init(temperature: 0.3, topP: 0.95, repetitionPenalty: 1.05, repetitionContextSize: 64),
        "mlx-community/Phi-4-mini-instruct-4bit": .init(temperature: 0.3, topP: 0.95, repetitionPenalty: 1.1, repetitionContextSize: 64),
    ]

    public static let fallback = SamplingPreset(temperature: 0.3, topP: 0.95, repetitionPenalty: 1.1, repetitionContextSize: 64)

    public static func preset(for repoId: String) -> SamplingPreset {
        presets[repoId] ?? fallback
    }
}

public struct ChatTurn: Codable, Sendable, Equatable {
    public let role: String
    public let content: String

    public init(role: String, content: String) {
        self.role = role
        self.content = content
    }
}

public enum ChatTurns {
    /// Makes a conversation acceptable to strict templates (Gemma rejects
    /// non-alternating roles): one leading system turn, no assistant turn
    /// before the first user turn, same-role neighbours merged, empty turns dropped.
    public static func normalized(_ turns: [ChatTurn]) -> [ChatTurn] {
        var merged: [ChatTurn] = []
        var sawUser = false
        for turn in turns where !turn.content.isEmpty {
            if turn.role == "system", sawUser || merged.contains(where: { $0.role != "system" }) {
                // A late system turn is folded into the opening one.
                if let index = merged.firstIndex(where: { $0.role == "system" }) {
                    merged[index] = ChatTurn(role: "system", content: merged[index].content + "\n\n" + turn.content)
                } else {
                    merged.insert(turn, at: 0)
                }
                continue
            }
            if turn.role == "user" { sawUser = true }
            if turn.role == "assistant" && !sawUser { continue }
            if let last = merged.last, last.role == turn.role {
                merged[merged.count - 1] = ChatTurn(role: last.role, content: last.content + "\n\n" + turn.content)
            } else {
                merged.append(turn)
            }
        }
        return merged
    }
}

/// Whether a downloaded model folder has a chat template swift-transformers can select.
public enum ModelChatTemplate {
    public static func isUsable(in directory: URL) -> Bool {
        let configURL = directory.appendingPathComponent("tokenizer_config.json")
        var config: [String: Any] = [:]
        if FileManager.default.fileExists(atPath: configURL.path) {
            guard let parsed = object(at: configURL) else { return false }
            config = parsed
        }
        let jinjaURL = directory.appendingPathComponent("chat_template.jinja")
        if FileManager.default.fileExists(atPath: jinjaURL.path) {
            if let template = regularText(at: jinjaURL) { return nonempty(template) }
        } else if let external = object(at: directory.appendingPathComponent("chat_template.json")),
                  let template = external["chat_template"] as? String {
            return nonempty(template)
        }
        if let template = config["chat_template"] as? String { return nonempty(template) }
        guard let entries = config["chat_template"] as? [Any] else { return false }
        var templates: [String: String] = [:]
        for value in entries {
            guard let entry = value as? [String: Any],
                  let name = entry["name"] as? String,
                  let template = entry["template"] as? String else { continue }
            guard templates[name] == nil else { return false }
            templates[name] = template
        }
        return templates["default"].map(nonempty) ?? false
    }

    private static func nonempty(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func regularText(at url: URL) -> String? {
        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    private static func object(at url: URL) -> [String: Any]? {
        guard let text = regularText(at: url), let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

/// Hugging Face repo ids only: `publisher/model`, no path tricks.
public enum RepoId {
    public static func validate(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.count <= 128 else { return nil }
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        guard parts.count == 2, parts.allSatisfy({ part in
            !part.isEmpty && part != "." && part != ".." && part.unicodeScalars.allSatisfy(allowed.contains)
        }) else { return nil }
        return value
    }
}
