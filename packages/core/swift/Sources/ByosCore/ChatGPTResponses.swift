import Foundation

/// ChatGPT-plan Responses API shaping and stream reading, the same rules as @byos/core's
/// chatgpt-responses.ts and the vectors in conformance/request-shaping.json. Ported from Skim
/// (NativeChatGPT.swift). Plan usage refuses sampling and length fields, so none are sent;
/// `store: false` keeps turns off the account's history; the answer is complete only at
/// `response.completed`.
public enum ChatGPTResponses {
    public struct Turn: Sendable, Equatable, Decodable {
        public enum Role: String, Sendable, Decodable { case system, user, assistant }
        public var role: Role
        public var content: String
        public init(role: Role, content: String) {
            self.role = role
            self.content = content
        }
    }

    /// Conversation turns as Responses `input`; system turns are dropped (they go in `instructions`).
    public static func input(_ turns: [Turn]) -> [[String: Any]] {
        turns.filter { $0.role != .system }.map { turn in
            let assistant = turn.role == .assistant
            return [
                "role": assistant ? "assistant" : "user",
                "content": [["type": assistant ? "output_text" : "input_text", "text": turn.content]],
            ]
        }
    }

    /// The request body. The first non-empty system turn wins over `instructions`.
    public static func body(model: String, instructions: String = "", turns: [Turn]) -> [String: Any] {
        let system = turns.first(where: { $0.role == .system && !$0.content.isEmpty })?.content ?? instructions
        return ["model": model, "instructions": system, "input": input(turns), "store": false, "stream": true]
    }

    /// Text of a finished response object: every `output_text` part, in order.
    public static func outputText(of response: [String: Any]) -> String {
        let output = response["output"] as? [[String: Any]] ?? []
        return output
            .flatMap { $0["content"] as? [[String: Any]] ?? [] }
            .filter { $0["type"] as? String == "output_text" }
            .compactMap { $0["text"] as? String }
            .joined()
    }

    /// A plain sentence for a Responses error code and message.
    public static func friendlyError(code: String?, message: String?, appName: String = "this app") -> String {
        switch code {
        case "subscription_sharing_usage_limit_exceeded":
            return "Your ChatGPT plan's limit for \(appName) is used up. Raise it in ChatGPT's usage settings or wait for it to reset."
        case "subscription_sharing_user_not_eligible":
            return "This ChatGPT account's plan can't be used in other apps. Plus and Pro plans can."
        case "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable":
            return "ChatGPT plan usage is unavailable right now. Try again shortly."
        case "subscription_sharing_invalid_user", "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context":
            return "ChatGPT needs you to sign in again. Open Settings to reconnect."
        default:
            if let message, !message.isEmpty {
                let reason = message.count > 240 ? String(message.prefix(240)) + "…" : message
                return "ChatGPT couldn't run this request: \(reason)"
            }
            return "ChatGPT couldn't run this request. Try again."
        }
    }

    /// Reads a Responses SSE stream one line at a time.
    public struct Stream: Sendable {
        public private(set) var text = ""
        public private(set) var completed = false
        public let appName: String

        public init(appName: String = "this app") {
            self.appName = appName
        }

        /// Takes one SSE line; returns true when the response is complete.
        public mutating func consume(_ line: String) throws -> Bool {
            guard line.hasPrefix("data:") else { return false }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard payload != "[DONE]", let data = payload.data(using: .utf8),
                  let event = (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) as? [String: Any]
            else { return false }
            let response = event["response"] as? [String: Any]
            switch event["type"] as? String {
            case "response.output_text.delta":
                text += event["delta"] as? String ?? ""
            case "response.completed":
                if text.isEmpty, let response { text = ChatGPTResponses.outputText(of: response) }
                completed = true
                return true
            case "response.incomplete":
                if text.isEmpty, let response { text = ChatGPTResponses.outputText(of: response) }
                guard !text.isEmpty else {
                    let reason = (response?["incomplete_details"] as? [String: Any])?["reason"] as? String
                    throw ChatGPTResponseError(message: "ChatGPT stopped before answering\(reason.map { " (\($0))" } ?? "").")
                }
                completed = true
                return true
            case "response.failed":
                let error = response?["error"] as? [String: Any]
                let code = error?["code"] as? String
                throw ChatGPTResponseError(message: ChatGPTResponses.friendlyError(code: code, message: error?["message"] as? String, appName: appName), code: code)
            case "error":
                let error = (event["error"] as? [String: Any]) ?? event
                let code = error["code"] as? String
                throw ChatGPTResponseError(message: ChatGPTResponses.friendlyError(code: code, message: error["message"] as? String, appName: appName), code: code)
            default:
                break
            }
            return false
        }

        /// The trimmed answer; throws when the stream ended early or carried no text.
        public func finish() throws -> String {
            guard completed else { throw ChatGPTResponseError(message: "ChatGPT's answer was cut off. Try again.") }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { throw ChatGPTResponseError(message: "The ChatGPT response was empty.") }
            return trimmed
        }
    }
}

/// A Responses failure; `message` is safe to show.
public struct ChatGPTResponseError: LocalizedError, Equatable, Sendable {
    public let message: String
    public let code: String?
    public init(message: String, code: String? = nil) {
        self.message = message
        self.code = code
    }
    public var errorDescription: String? { message }
}
