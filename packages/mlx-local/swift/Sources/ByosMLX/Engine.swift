import Foundation
import MLX
import MLXLLM
import MLXLMCommon

public struct Sampling: Sendable, Equatable {
    public var maxTokens: Int
    public var temperature: Float
    public var topP: Float
    public var repetitionPenalty: Float?
    public var repetitionContextSize: Int

    public init(maxTokens: Int, temperature: Float, topP: Float, repetitionPenalty: Float?, repetitionContextSize: Int) {
        self.maxTokens = maxTokens
        self.temperature = temperature
        self.topP = topP
        self.repetitionPenalty = repetitionPenalty
        self.repetitionContextSize = repetitionContextSize
    }

    var parameters: GenerateParameters {
        GenerateParameters(
            maxTokens: maxTokens, temperature: temperature, topP: topP,
            repetitionPenalty: repetitionPenalty, repetitionContextSize: repetitionContextSize)
    }
}

/// What one generation cost.
public struct GenerationStats: Codable, Sendable, Equatable {
    public var promptTokens = 0
    public var generatedTokens = 0
    public var timeToFirstTokenSeconds = 0.0
    public var decodeTokensPerSecond = 0.0
    public var totalSeconds = 0.0
    /// MLX peak active memory during the call, weights included.
    public var peakMemoryBytes = 0
}

public enum EngineError: LocalizedError, Equatable {
    case promptTooLong(tokens: Int, limit: Int)
    case generationFailed(String)

    public var errorDescription: String? {
        switch self {
        case .promptTooLong(let tokens, let limit):
            return "The prompt is \(tokens) tokens; this on-device model reads at most \(limit)."
        case .generationFailed(let message):
            return message
        }
    }
}

public enum MLXRuntime {
    /// Caps the buffer cache MLX keeps between calls.
    public static func setCacheLimit(bytes: Int) { Memory.cacheLimit = bytes }
}

/// A loaded MLX model. Calls run one at a time inside the model container.
public final class MLXChatModel: @unchecked Sendable {
    public let repoId: String
    public let family: ModelFamily
    private let container: ModelContainer

    private init(repoId: String, family: ModelFamily, container: ModelContainer) {
        self.repoId = repoId
        self.family = family
        self.container = container
    }

    public static func load(repoId: String, directory: URL) async throws -> MLXChatModel {
        let family = ModelFamily.detect(from: repoId)
        let configuration = ModelConfiguration(directory: directory, extraEOSTokens: Set(family.stopStrings))
        let container = try await LLMModelFactory.shared.loadContainer(
            from: LocalOnlyDownloader(), using: TokenizerLoader(), configuration: configuration)
        return MLXChatModel(repoId: repoId, family: family, container: container)
    }

    /// Streams raw model text to `onChunk`. Cancelling the calling task stops decoding.
    public func generate(
        turns: [ChatTurn],
        sampling: Sampling,
        maxPromptTokens: Int,
        onChunk: @Sendable @escaping (String) -> Void
    ) async throws -> GenerationStats {
        let messages = ChatTurns.normalized(turns).map { ["role": $0.role, "content": $0.content] as [String: any Sendable] }
        let additionalContext: [String: any Sendable]? = family.supportsThinkingToggle ? ["enable_thinking": false] : nil
        let parameters = sampling.parameters

        return try await container.perform { (context: ModelContext) -> GenerationStats in
            let start = Date()
            Memory.peakMemory = 0
            let lmInput = try await context.processor.prepare(
                input: UserInput(messages: messages, additionalContext: additionalContext))
            let promptTokens = lmInput.text.tokens.size
            guard promptTokens <= maxPromptTokens else {
                throw EngineError.promptTooLong(tokens: promptTokens, limit: maxPromptTokens)
            }
            try Task.checkCancellation()

            // withError turns MLX C-layer failures into Swift errors instead of
            // aborting the process; it must wrap the task where MLX evaluates.
            do {
                return try await MLX.withError {
                    let iterator = try TokenIterator(input: lmInput, model: context.model, parameters: parameters)
                    let (stream, task) = generateTask(
                        promptTokenCount: promptTokens,
                        modelConfiguration: context.configuration,
                        tokenizer: context.tokenizer,
                        iterator: iterator)

                    var firstChunkAt: Date?
                    var info: GenerateCompletionInfo?
                    for await event in stream {
                        if Task.isCancelled {
                            task.cancel()
                            break
                        }
                        switch event {
                        case .chunk(let chunk):
                            if firstChunkAt == nil { firstChunkAt = Date() }
                            onChunk(chunk)
                        case .info(let completion):
                            info = completion
                        case .toolCall, .rejectedToolCall:
                            break
                        }
                    }
                    await task.value
                    try Task.checkCancellation()

                    let end = Date()
                    var stats = GenerationStats()
                    stats.promptTokens = promptTokens
                    stats.generatedTokens = info?.generationTokenCount ?? 0
                    stats.timeToFirstTokenSeconds = (firstChunkAt ?? end).timeIntervalSince(start)
                    stats.decodeTokensPerSecond = info?.tokensPerSecond ?? 0
                    stats.totalSeconds = end.timeIntervalSince(start)
                    stats.peakMemoryBytes = Memory.peakMemory
                    return stats
                }
            } catch let error as MLX.MLXError {
                throw EngineError.generationFailed(error.localizedDescription)
            }
        }
    }
}
