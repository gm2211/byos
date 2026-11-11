import Foundation
import XCTest
@testable import ByosCore

/// Runs the vectors @byos/core's TypeScript tests use (conformance/request-shaping.json).
final class RequestShapingTests: XCTestCase {
    struct ClaudeModel: Decodable {
        let model: String
        let acceptsTemperature: Bool
        let thinksByDefault: Bool
    }
    struct ClaudeBody: Decodable {
        struct Input: Decodable {
            let model: String
            let maxTokens: Int
            let temperature: Double?
            let effort: String?
            let subscription: Bool
            let instructions: String
        }
        enum System: Decodable, Equatable {
            case text(String)
            case blocks([String])
            init(from decoder: Decoder) throws {
                let container = try decoder.singleValueContainer()
                if let text = try? container.decode(String.self) { self = .text(text) } else { self = .blocks(try container.decode([String].self)) }
            }
        }
        struct Expect: Decodable {
            let maxTokens: Int
            let temperature: Double?
            let effort: String?
            let thinking: Bool
            let system: System
        }
        let name: String
        let input: Input
        let expect: Expect
    }
    struct ClaudeEmpty: Decodable {
        let stopReason: String?
        let expect: String
    }
    struct ChatGPTBody: Decodable {
        let name: String
        let model: String
        let instructions: String
        let turns: [ChatGPTResponses.Turn]
        let expect: AnyJSON
    }
    struct ChatGPTStream: Decodable {
        struct Expect: Decodable {
            let text: String?
            let error: String?
        }
        let name: String
        let lines: [String]
        let expect: Expect
    }
    struct ChatGPTErrorCase: Decodable {
        let code: String?
        let message: String?
        let expect: String
    }
    struct Vectors: Decodable {
        let claudeModels: [ClaudeModel]
        let claudeBodies: [ClaudeBody]
        let claudeEmpty: [ClaudeEmpty]
        let chatgptBodies: [ChatGPTBody]
        let chatgptStreams: [ChatGPTStream]
        let chatgptErrors: [ChatGPTErrorCase]
        let appName: String
    }

    /// Any JSON value, compared through JSONSerialization so key order doesn't matter.
    struct AnyJSON: Decodable {
        let value: Any
        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if container.decodeNil() { value = NSNull() }
            else if let bool = try? container.decode(Bool.self) { value = bool }
            else if let number = try? container.decode(Double.self) { value = number }
            else if let text = try? container.decode(String.self) { value = text }
            else if let array = try? container.decode([AnyJSON].self) { value = array.map(\.value) }
            else { value = try container.decode([String: AnyJSON].self).mapValues(\.value) }
        }
    }

    static func vectors() throws -> Vectors {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/request-shaping.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testClaudeModelsMatchTheVectors() throws {
        for c in try Self.vectors().claudeModels {
            XCTAssertEqual(ClaudeRequest.acceptsTemperature(c.model), c.acceptsTemperature, c.model)
            XCTAssertEqual(ClaudeRequest.thinksByDefault(c.model), c.thinksByDefault, c.model)
        }
    }

    func testClaudeBodiesMatchTheVectors() throws {
        for c in try Self.vectors().claudeBodies {
            let messages: [[String: Any]] = [["role": "user", "content": "hi"]]
            let body = ClaudeRequest.body(
                model: c.input.model, messages: messages, instructions: c.input.instructions,
                subscription: c.input.subscription, maxTokens: c.input.maxTokens,
                temperature: c.input.temperature, effort: c.input.effort
            )
            XCTAssertEqual(body["model"] as? String, c.input.model, c.name)
            XCTAssertEqual(body["max_tokens"] as? Int, c.expect.maxTokens, c.name)
            XCTAssertEqual(body["temperature"] as? Double, c.expect.temperature, c.name)
            XCTAssertEqual((body["output_config"] as? [String: Any])?["effort"] as? String, c.expect.effort, c.name)
            XCTAssertEqual((body["thinking"] as? [String: Any])?["type"] as? String, c.expect.thinking ? "adaptive" : nil, c.name)
            XCTAssertNil(body["stream"], c.name)
            XCTAssertNil(body["tools"], c.name)
            switch c.expect.system {
            case .text(let text):
                XCTAssertEqual(body["system"] as? String, text, c.name)
            case .blocks(let texts):
                let blocks = try XCTUnwrap(body["system"] as? [[String: Any]], c.name)
                XCTAssertEqual(blocks.compactMap { $0["text"] as? String }, texts, c.name)
                XCTAssertEqual(blocks.compactMap { $0["type"] as? String }, Array(repeating: "text", count: texts.count), c.name)
            }
            XCTAssertTrue(JSONSerialization.isValidJSONObject(body), c.name)
        }
    }

    func testClaudeBodyAddsStreamAndToolsWhenAsked() {
        let body = ClaudeRequest.body(model: "claude-sonnet-5-5", messages: [], subscription: false, maxTokens: 10, stream: true, tools: [["name": "t"]])
        XCTAssertEqual(body["stream"] as? Bool, true)
        XCTAssertEqual((body["tools"] as? [[String: Any]])?.first?["name"] as? String, "t")
    }

    func testClaudeEmptyAnswersMatchTheVectors() throws {
        for c in try Self.vectors().claudeEmpty {
            XCTAssertEqual(ClaudeRequest.emptyResponseMessage(stopReason: c.stopReason), c.expect)
        }
    }

    func testChatGPTBodiesMatchTheVectors() throws {
        for c in try Self.vectors().chatgptBodies {
            let body = ChatGPTResponses.body(model: c.model, instructions: c.instructions, turns: c.turns)
            let actual = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: body)) as? NSDictionary
            let expected = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: c.expect.value)) as? NSDictionary
            XCTAssertEqual(actual, expected, c.name)
        }
    }

    func testChatGPTStreamsMatchTheVectors() throws {
        let vectors = try Self.vectors()
        for c in vectors.chatgptStreams {
            var stream = ChatGPTResponses.Stream(appName: vectors.appName)
            do {
                for line in c.lines {
                    if try stream.consume(line) { break }
                }
                let text = try stream.finish()
                XCTAssertNil(c.expect.error, "\(c.name): expected an error, got \(text)")
                XCTAssertEqual(text, c.expect.text, c.name)
            } catch let error as ChatGPTResponseError {
                XCTAssertEqual(error.message, c.expect.error, c.name)
            }
        }
    }

    func testChatGPTErrorsMatchTheVectors() throws {
        let vectors = try Self.vectors()
        for c in vectors.chatgptErrors {
            XCTAssertEqual(ChatGPTResponses.friendlyError(code: c.code, message: c.message, appName: vectors.appName), c.expect, c.code ?? "nil")
        }
    }

    // MARK: - Pacer

    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    func testBackgroundWaitsWhileForegroundRuns() async {
        let pacer = RequestPacer()
        await pacer.start(.foreground)
        let background = Task { await pacer.start(.background) }
        await settle()
        let waiting = await pacer.waitingInBackground
        XCTAssertEqual(waiting, 1)
        await pacer.finish(.foreground)
        await background.value
        let inFlight = await pacer.inFlightInBackground
        XCTAssertEqual(inFlight, 1)
    }

    func testBackgroundRunsOneAtATimeByDefault() async {
        let pacer = RequestPacer()
        await pacer.start(.background)
        let second = Task { await pacer.start(.background) }
        await settle()
        let waiting = await pacer.waitingInBackground
        XCTAssertEqual(waiting, 1)
        await pacer.finish(.background)
        await second.value
        let inFlight = await pacer.inFlightInBackground
        XCTAssertEqual(inFlight, 1)
    }

    func testWiderWorkRunsSeveralAtOnce() async {
        let pacer = RequestPacer()
        for _ in 0..<3 { await pacer.start(.background, width: 3) }
        let inFlight = await pacer.inFlightInBackground
        XCTAssertEqual(inFlight, 3)
        let fourth = Task { await pacer.start(.background, width: 3) }
        await settle()
        let waiting = await pacer.waitingInBackground
        XCTAssertEqual(waiting, 1)
        await pacer.reset()
        await fourth.value
    }

    func testRunReleasesItsSlotWhenWorkThrows() async {
        struct Boom: Error {}
        let pacer = RequestPacer()
        do {
            _ = try await pacer.run(.foreground) { () async throws -> Int in throw Boom() }
            XCTFail("expected a throw")
        } catch {}
        let foreground = await pacer.inFlightInForeground
        XCTAssertEqual(foreground, 0)
        let value = await pacer.run(.foreground) { 7 }
        XCTAssertEqual(value, 7)
    }
}
