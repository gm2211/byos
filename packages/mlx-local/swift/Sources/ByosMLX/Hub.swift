import Foundation
import Hub
import MLXLMCommon
import Tokenizers

// mlx-swift-lm 3.x ships no downloader or tokenizer. These adapters plug in
// swift-transformers, as Skim does, without the macro plugin.

struct TokenizerLoader: MLXLMCommon.TokenizerLoader {
    func load(from directory: URL) async throws -> any MLXLMCommon.Tokenizer {
        TokenizerBridge(try await Tokenizers.AutoTokenizer.from(modelFolder: directory))
    }
}

struct TokenizerBridge: MLXLMCommon.Tokenizer {
    let upstream: any Tokenizers.Tokenizer

    init(_ upstream: any Tokenizers.Tokenizer) { self.upstream = upstream }

    func encode(text: String, addSpecialTokens: Bool) -> [Int] {
        upstream.encode(text: text, addSpecialTokens: addSpecialTokens)
    }

    func decode(tokenIds: [Int], skipSpecialTokens: Bool) -> String {
        upstream.decode(tokens: tokenIds, skipSpecialTokens: skipSpecialTokens)
    }

    func convertTokenToId(_ token: String) -> Int? { upstream.convertTokenToId(token) }
    func convertIdToToken(_ id: Int) -> String? { upstream.convertIdToToken(id) }
    var bosToken: String? { upstream.bosToken }
    var eosToken: String? { upstream.eosToken }
    var unknownToken: String? { upstream.unknownToken }

    func applyChatTemplate(
        messages: [[String: any Sendable]],
        tools: [[String: any Sendable]]?,
        additionalContext: [String: any Sendable]?
    ) throws -> [Int] {
        do {
            return try upstream.applyChatTemplate(messages: messages, tools: tools, additionalContext: additionalContext)
        } catch Tokenizers.TokenizerError.missingChatTemplate {
            throw MLXLMCommon.TokenizerError.missingChatTemplate
        }
    }
}

/// Model storage: `<root>/models/<publisher>/<model>`, the Hugging Face
/// snapshot layout. Skim keeps its models under `~/Documents/huggingface`,
/// so pointing `root` there shares them.
public struct ModelStore: Sendable {
    /// Weights, configs, tokenizer and the standalone `chat_template.jinja`.
    public static let filePatterns = ["*.safetensors", "*.json", "*.jinja", "tokenizer.model"]

    public let root: URL

    public init(root: URL) { self.root = root }

    public func directory(for repoId: String) -> URL {
        root.appendingPathComponent("models/\(repoId)", isDirectory: true)
    }

    public func isDownloaded(_ repoId: String) -> Bool {
        let dir = directory(for: repoId)
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return files.contains("config.json") && files.contains(where: { $0.hasSuffix(".safetensors") })
            && ModelChatTemplate.isUsable(in: dir)
    }

    /// Every complete model on disk, with its size in bytes.
    public func downloaded() -> [(id: String, bytes: Int64)] {
        let modelsDir = root.appendingPathComponent("models", isDirectory: true)
        let fm = FileManager.default
        var result: [(String, Int64)] = []
        for publisher in (try? fm.contentsOfDirectory(atPath: modelsDir.path)) ?? [] where !publisher.hasPrefix(".") {
            let publisherDir = modelsDir.appendingPathComponent(publisher, isDirectory: true)
            for model in (try? fm.contentsOfDirectory(atPath: publisherDir.path)) ?? [] where !model.hasPrefix(".") {
                let id = "\(publisher)/\(model)"
                guard RepoId.validate(id) != nil, isDownloaded(id) else { continue }
                result.append((id, size(of: directory(for: id))))
            }
        }
        return result.sorted { $0.0 < $1.0 }
    }

    public func download(_ repoId: String, progress: @Sendable @escaping (Double) -> Void) async throws {
        // No second blob cache: it would double every multi-GB weight file.
        let hub = HubApi(downloadBase: root, cache: nil, useBackgroundSession: false)
        _ = try await hub.snapshot(from: Hub.Repo(id: repoId), revision: "main", matching: Self.filePatterns) {
            progress($0.fractionCompleted)
        }
    }

    public func delete(_ repoId: String) throws {
        let dir = directory(for: repoId)
        if FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.removeItem(at: dir)
        }
    }

    private func size(of directory: URL) -> Int64 {
        guard let walker = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in walker {
            total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }
}

/// Satisfies `loadContainer(from:)`; models are always local by then.
struct LocalOnlyDownloader: MLXLMCommon.Downloader {
    func download(
        id: String, revision: String?, matching patterns: [String], useLatest: Bool,
        progressHandler: @Sendable @escaping (Progress) -> Void
    ) async throws -> URL {
        throw CocoaError(.fileNoSuchFile)
    }
}
