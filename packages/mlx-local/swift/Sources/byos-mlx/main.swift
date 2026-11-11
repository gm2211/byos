// byos-mlx: on-device inference helper for @byos/mlx-local.
//
// Speaks newline-delimited JSON on stdin/stdout (protocol version 1, see
// packages/mlx-local/README.md). Every request carries an `id`; replies for
// it are zero or more `progress`/`start`/`text` lines, then exactly one
// `result` or `error` line. Requests run concurrently; generations share one
// loaded model and run one at a time. Prompts and output never go to stderr.

import ByosMLX
import Foundation
import Metal
#if canImport(FoundationModels)
import FoundationModels
#endif

let protocolVersion = 1

struct Request: Decodable {
    let id: String
    let op: String
    let model: String?
    let engine: String?
    let messages: [ChatTurn]?
    let maxTokens: Int?
    let temperature: Float?
    let topP: Float?
    let target: String?
}

struct BridgeError: Error {
    let code: String
    let message: String
}

// MARK: - Output

let outputLock = NSLock()

func send(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
    outputLock.lock()
    defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

// MARK: - Configuration

func modelsRoot() -> URL {
    let args = CommandLine.arguments
    if let index = args.firstIndex(of: "--models-dir"), index + 1 < args.count {
        return URL(fileURLWithPath: (args[index + 1] as NSString).expandingTildeInPath, isDirectory: true)
    }
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("BYOS/mlx", isDirectory: true)
}

let store = ModelStore(root: modelsRoot())
/// Macs have the memory for long prompts; this only stops a runaway one.
let maxPromptTokens = 32_768

func mlxAvailability() -> [String: Any] {
    #if arch(arm64)
    guard MTLCreateSystemDefaultDevice() != nil else {
        return ["available": false, "reason": "No Metal GPU is available to MLX on this Mac."]
    }
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let metallib = exe.deletingLastPathComponent().appendingPathComponent("mlx.metallib")
    guard FileManager.default.fileExists(atPath: metallib.path) else {
        return ["available": false, "reason": "mlx.metallib is missing next to byos-mlx. Rebuild it with scripts/build-bridge.sh."]
    }
    return ["available": true]
    #else
    return ["available": false, "reason": "MLX needs an Apple silicon Mac."]
    #endif
}

func foundationAvailability() -> [String: Any] {
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        switch SystemLanguageModel.default.availability {
        case .available:
            return ["available": true]
        case .unavailable(.deviceNotEligible):
            return ["available": false, "reason": "This Mac is not eligible for Apple Intelligence."]
        case .unavailable(.appleIntelligenceNotEnabled):
            return ["available": false, "reason": "Apple Intelligence is off. Turn it on in System Settings."]
        case .unavailable(.modelNotReady):
            return ["available": false, "reason": "Apple's on-device model is still downloading."]
        default:
            return ["available": false, "reason": "Apple's on-device model is unavailable."]
        }
    }
    #endif
    return ["available": false, "reason": "Apple Intelligence needs macOS 26 or later."]
}

// MARK: - MLX

actor ModelHolder {
    private var model: MLXChatModel?

    func model(for repoId: String) async throws -> MLXChatModel {
        if let model, model.repoId == repoId { return model }
        model = nil
        guard store.isDownloaded(repoId) else {
            throw BridgeError(code: "model-not-downloaded", message: "\(repoId) is not downloaded.")
        }
        let loaded = try await MLXChatModel.load(repoId: repoId, directory: store.directory(for: repoId))
        model = loaded
        return loaded
    }

    func evict(_ repoId: String) {
        if model?.repoId == repoId { model = nil }
    }
}

let holder = ModelHolder()

func generateMLX(_ request: Request) async throws -> [String: Any] {
    guard let repoId = RepoId.validate(request.model) else {
        throw BridgeError(code: "invalid-model", message: "Expected a Hugging Face model id like publisher/model.")
    }
    let availability = mlxAvailability()
    guard availability["available"] as? Bool == true else {
        throw BridgeError(code: "unavailable", message: availability["reason"] as? String ?? "MLX is unavailable.")
    }
    let model = try await holder.model(for: repoId)
    let preset = SamplingPreset.preset(for: repoId)
    let sampling = Sampling(
        maxTokens: min(max(request.maxTokens ?? 1024, 1), 32_768),
        temperature: request.temperature ?? preset.temperature,
        topP: request.topP ?? preset.topP,
        repetitionPenalty: preset.repetitionPenalty,
        repetitionContextSize: preset.repetitionContextSize)
    send(["id": request.id, "type": "start", "stop": model.family.stopStrings])
    let id = request.id
    let stats = try await model.generate(
        turns: request.messages ?? [], sampling: sampling, maxPromptTokens: maxPromptTokens
    ) { chunk in
        send(["id": id, "type": "text", "text": chunk])
    }
    return [
        "inputTokens": stats.promptTokens,
        "outputTokens": stats.generatedTokens,
        "timeToFirstTokenSeconds": stats.timeToFirstTokenSeconds,
        "decodeTokensPerSecond": stats.decodeTokensPerSecond,
        "peakMemoryBytes": stats.peakMemoryBytes,
    ]
}

// MARK: - Apple Foundation Models

func generateFoundation(_ request: Request) async throws -> [String: Any] {
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        let availability = foundationAvailability()
        guard availability["available"] as? Bool == true else {
            throw BridgeError(code: "unavailable", message: availability["reason"] as? String ?? "Unavailable.")
        }
        var turns = ChatTurns.normalized(request.messages ?? [])
        let instructions = turns.first?.role == "system" ? turns.removeFirst().content : ""
        guard let last = turns.popLast(), last.role == "user" else {
            throw BridgeError(code: "invalid-request", message: "The conversation must end with a user turn.")
        }
        var entries: [Transcript.Entry] = [
            .instructions(.init(segments: [.text(.init(content: instructions))], toolDefinitions: []))
        ]
        for turn in turns {
            let segments: [Transcript.Segment] = [.text(.init(content: turn.content))]
            entries.append(turn.role == "assistant"
                ? .response(.init(assetIDs: [], segments: segments))
                : .prompt(.init(segments: segments)))
        }
        let session = LanguageModelSession(transcript: Transcript(entries: entries))
        var options = GenerationOptions(maximumResponseTokens: request.maxTokens ?? 1024)
        if let temperature = request.temperature {
            options = GenerationOptions(
                sampling: temperature == 0 ? .greedy : nil,
                temperature: Double(temperature),
                maximumResponseTokens: request.maxTokens ?? 1024)
        }
        send(["id": request.id, "type": "start", "stop": [String]()])
        // Snapshots are cumulative; forward only what is new.
        var sent = ""
        for try await snapshot in session.streamResponse(to: last.content, options: options) {
            let content = snapshot.content
            if content.hasPrefix(sent) {
                let delta = String(content.dropFirst(sent.count))
                if !delta.isEmpty { send(["id": request.id, "type": "text", "text": delta]) }
                sent = content
            }
        }
        return [:]
    }
    #endif
    throw BridgeError(code: "unavailable", message: "Apple Intelligence needs macOS 26 or later.")
}

// MARK: - Dispatch

func handle(_ request: Request) async throws -> [String: Any] {
    switch request.op {
    case "hello":
        return ["protocol": protocolVersion, "modelsDir": store.root.path]
    case "status":
        return ["mlx": mlxAvailability(), "foundationModels": foundationAvailability()]
    case "list":
        return ["models": store.downloaded().map { ["id": $0.id, "bytes": $0.bytes] }]
    case "download":
        guard let repoId = RepoId.validate(request.model) else {
            throw BridgeError(code: "invalid-model", message: "Expected a Hugging Face model id like publisher/model.")
        }
        let id = request.id
        try await store.download(repoId) { send(["id": id, "type": "progress", "fraction": $0]) }
        try Task.checkCancellation()
        guard store.isDownloaded(repoId) else {
            throw BridgeError(code: "invalid-model", message: "\(repoId) has no usable MLX weights or chat template.")
        }
        await holder.evict(repoId)
        return [:]
    case "delete":
        guard let repoId = RepoId.validate(request.model) else {
            throw BridgeError(code: "invalid-model", message: "Expected a Hugging Face model id like publisher/model.")
        }
        await holder.evict(repoId)
        try store.delete(repoId)
        return [:]
    case "generate":
        return request.engine == "foundation-models" ? try await generateFoundation(request) : try await generateMLX(request)
    default:
        throw BridgeError(code: "invalid-request", message: "Unknown op \(request.op).")
    }
}

/// Running requests by id, so `cancel` can reach them.
final class Tasks: @unchecked Sendable {
    private let lock = NSLock()
    private var running: [String: Task<Void, Never>] = [:]

    func add(_ id: String, _ task: Task<Void, Never>) { lock.withLock { running[id] = task } }
    func remove(_ id: String) { lock.withLock { running[id] = nil } }
    func cancel(_ id: String) { lock.withLock { running[id] }?.cancel() }
}

let tasks = Tasks()
MLXRuntime.setCacheLimit(bytes: 512 * 1024 * 1024)

DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty else { continue }
        guard let request = try? JSONDecoder().decode(Request.self, from: Data(line.utf8)) else {
            send(["id": "", "type": "error", "code": "invalid-request", "message": "Malformed request."])
            continue
        }
        if request.op == "cancel" {
            tasks.cancel(request.target ?? "")
            continue
        }
        // The task waits on this lock so it cannot finish before it is registered.
        let gate = NSLock()
        gate.lock()
        let task = Task {
            gate.withLock {}
            do {
                let value = try await handle(request)
                send(["id": request.id, "type": "result", "value": value])
            } catch is CancellationError {
                send(["id": request.id, "type": "error", "code": "aborted", "message": "Canceled."])
            } catch let error as BridgeError {
                send(["id": request.id, "type": "error", "code": error.code, "message": error.message])
            } catch {
                send(["id": request.id, "type": "error", "code": "failed", "message": error.localizedDescription])
            }
            tasks.remove(request.id)
        }
        tasks.add(request.id, task)
        gate.unlock()
    }
    // stdin closed: the client is gone.
    exit(0)
}
dispatchMain()
