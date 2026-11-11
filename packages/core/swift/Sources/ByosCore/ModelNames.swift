import Foundation

/// Short model names a person would say, the same rules as @byos/core's model-names.ts and the vectors
/// in conformance/text-polish.json. Ported from Skim's ModelCatalog.friendlyName.
public enum ModelNames {
    /// Model families whose ids read as words plus a version ("grok-4-1-fast" is "Grok 4.1 Fast").
    static let wordFamilies = ["grok", "gemini", "gemma", "llama", "mistral", "qwen", "deepseek", "kimi"]
    static let claudeFamilies = ["opus", "sonnet", "haiku", "fable"]

    /// "claude-sonnet-5-5" is "Sonnet 5.5", "anthropic/claude-3-5-haiku-20241022" is "Haiku 3.5",
    /// "gpt-4o-mini" is "GPT-4o mini", "x-ai/grok-4-1-fast" is "Grok 4.1 Fast". A ":batch" style tag
    /// survives as "(batch)". An id from a family it does not know comes back unchanged.
    public static func friendly(_ id: String) -> String {
        var name = id.trimmingCharacters(in: .whitespacesAndNewlines)
        var tag = ""
        if let colon = name.firstIndex(of: ":") {
            let rest = name[name.index(after: colon)...]
            if !rest.isEmpty { tag = " (\(rest))" }
            name = String(name[..<colon])
        }
        if let slash = name.lastIndex(of: "/") {
            name = String(name[name.index(after: slash)...])
        }
        var parts = name.lowercased().split(separator: "-").map(String.init)
        if let last = parts.last, last == "latest" || (last.count == 8 && isDigits(last)) {
            parts.removeLast()
        }
        // OpenAI's dated snapshots end "-2024-08-06".
        if parts.count > 3, parts.suffix(3).map(\.count) == [4, 2, 2], parts.suffix(3).allSatisfy(isDigits) {
            parts.removeLast(3)
        }
        guard let first = parts.first else { return id }

        if first == "claude" {
            guard let familyIndex = parts.firstIndex(where: { claudeFamilies.contains($0) }) else { return id }
            let version = parts[1...].filter(isVersion).joined(separator: ".")
            let extra = parts[1...].enumerated()
                .filter { $0.offset + 1 != familyIndex && !isVersion($0.element) }
                .map { capitalized($0.element) }
            return ([capitalized(parts[familyIndex])] + (version.isEmpty ? [] : [version]) + extra).joined(separator: " ") + tag
        }
        if first == "gpt", parts.count > 1 {
            var version = parts[1]
            var rest = parts.dropFirst(2)
            if isVersion(version), let next = rest.first, isVersion(next) {
                version += "." + next
                rest = rest.dropFirst()
            }
            return (["GPT-" + version] + rest).joined(separator: " ") + tag
        }
        if wordFamilies.contains(where: { first.hasPrefix($0) }) {
            return words(parts[...]).joined(separator: " ") + tag
        }
        return id
    }

    static func isDigits(_ part: String) -> Bool { !part.isEmpty && part.allSatisfy { $0.isASCII && $0.isNumber } }
    static func isVersion(_ part: String) -> Bool { part.count <= 2 && isDigits(part) }
    static func capitalized(_ part: String) -> String { part.prefix(1).uppercased() + part.dropFirst() }

    /// Words capitalized, runs of short numbers joined by "." ("4", "1" is "4.1").
    static func words(_ parts: ArraySlice<String>) -> [String] {
        var out: [String] = []
        var lastWasVersion = false
        for part in parts {
            if isVersion(part), lastWasVersion, let previous = out.popLast() {
                out.append(previous + "." + part)
            } else {
                out.append(isVersion(part) ? part : capitalized(part))
            }
            lastWasVersion = isVersion(part)
        }
        return out
    }
}
