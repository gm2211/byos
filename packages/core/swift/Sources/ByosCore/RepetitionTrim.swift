import Foundation

/// Trims the repetition loops small (often on-device) models fall into, the same rules as
/// @byos/core's repetition.ts and the vectors in conformance/text-polish.json. Ported from Skim's
/// NativeAI.degenerateRepetitionTrim.
public enum RepetitionTrim {
    private struct SentenceChunk {
        var range: Range<String.Index>
        var text: String
    }

    /// Splits `text` into sentence-ish chunks, breaking after ". ", "! ", "? ",
    /// or a newline. Deliberately simple and dependency-free: this is a heuristic
    /// for repetition detection, not a linguistic sentence tokenizer. The chunks'
    /// ranges are contiguous and cover the whole string, so joining chunk texts
    /// back together reconstructs `text` exactly.
    private static func splitIntoSentenceChunks(_ text: String) -> [SentenceChunk] {
        var chunks: [SentenceChunk] = []
        var start = text.startIndex
        var i = text.startIndex
        while i < text.endIndex {
            let c = text[i]
            if c == "\n" {
                let end = text.index(after: i)
                chunks.append(SentenceChunk(range: start..<end, text: String(text[start..<end])))
                start = end
                i = end
                continue
            }
            if c == "." || c == "!" || c == "?" {
                let next = text.index(after: i)
                if next < text.endIndex && text[next] == " " {
                    let end = text.index(after: next)
                    chunks.append(SentenceChunk(range: start..<end, text: String(text[start..<end])))
                    start = end
                    i = end
                    continue
                } else if next == text.endIndex {
                    chunks.append(SentenceChunk(range: start..<next, text: String(text[start..<next])))
                    start = next
                    i = next
                    continue
                }
            }
            i = text.index(after: i)
        }
        if start < text.endIndex {
            chunks.append(SentenceChunk(range: start..<text.endIndex, text: String(text[start..<text.endIndex])))
        }
        return chunks
    }

    /// Case/whitespace-insensitive normalization used to compare sentences for
    /// repetition purposes.
    private static func normalizeSentence(_ s: String) -> String {
        let collapsed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return collapsed
    }

    /// Detects a trailing sub-sentence loop: the raw text ends with the same
    /// substring (>= 12 characters) repeated >= 4 times back-to-back, with no
    /// sentence-level delimiters to split on (e.g. a runaway token loop). Returns
    /// the text trimmed to the first occurrence of the repeating unit, or `nil`
    /// if no such loop is found.
    private static func trimTrailingSubstringLoop(_ text: String) -> String? {
        let chars = Array(text)
        let n = chars.count
        guard n >= 48 else { return nil }
        let maxPeriod = min(n / 4, 400)
        guard maxPeriod >= 12 else { return nil }

        for period in 12...maxPeriod {
            let repeatLen = period * 4
            guard repeatLen <= n else { break }
            let tailStart = n - repeatLen
            let unitRange = tailStart..<(tailStart + period)
            let unit = chars[unitRange]
            // Skip near-blank "units" (e.g. runs of spaces/newlines) — not a
            // meaningful loop even if they repeat.
            if unit.allSatisfy({ $0.isWhitespace }) { continue }

            var isRepeating = true
            for k in 1..<4 {
                let segStart = tailStart + k * period
                let seg = chars[segStart..<(segStart + period)]
                if seg != unit {
                    isRepeating = false
                    break
                }
            }
            if isRepeating {
                // Extend backward to find where the loop actually starts, so we
                // trim to exactly one occurrence of the unit rather than the
                // four (or more) reps used to detect it.
                var loopStart = tailStart
                while loopStart - period >= 0 && chars[(loopStart - period)..<loopStart] == unit {
                    loopStart -= period
                }
                let cutIndex = loopStart + period
                return String(chars[0..<cutIndex])
            }
        }
        return nil
    }

    /// Detects and trims degenerate repetitive output from a small on-device
    /// model. Returns the (possibly trimmed) text and whether degeneration was
    /// detected at all.
    ///
    /// Detection rules:
    /// - The same normalized sentence appears >= 3 times consecutively, or
    /// - The final N sentences (N >= 5) contain <= 2 unique normalized sentences, or
    /// - The raw text ends with the same >= 12-character substring repeated
    ///   >= 4 times back-to-back (sub-sentence loop, e.g. no punctuation).
    ///
    /// When degenerate, the output is trimmed to the point where the repetition
    /// run begins, keeping everything before it. If trimming would remove the
    /// entire string, the first occurrence of the repeated content is kept
    /// instead so a non-empty input never yields an empty result.
    public static func trim(_ text: String) -> (text: String, wasDegenerate: Bool) {
        guard !text.isEmpty else { return (text, false) }

        // Sub-sentence loop check first — this catches degenerate output that
        // has no clean sentence delimiters to split on.
        if let trimmed = trimTrailingSubstringLoop(text), !trimmed.isEmpty {
            return (trimmed, true)
        }

        let chunks = splitIntoSentenceChunks(text)
        let nonBlank = chunks.enumerated().compactMap { _, chunk -> SentenceChunk? in
            normalizeSentence(chunk.text).isEmpty ? nil : chunk
        }
        guard nonBlank.count >= 3 else { return (text, false) }
        let normalized = nonBlank.map { normalizeSentence($0.text) }

        var runStart: Int?

        // Rule A: >= 3 consecutive identical normalized sentences.
        var i = 0
        while i < normalized.count {
            var j = i
            while j + 1 < normalized.count && normalized[j + 1] == normalized[i] {
                j += 1
            }
            let runLength = j - i + 1
            if runLength >= 3 {
                runStart = i
                break
            }
            i = j + 1
        }

        // Rule B: the final N sentences (N >= 5) contain <= 2 unique sentences.
        // Search increasing window sizes from 5 so we find the smallest (least
        // destructive) qualifying trim.
        if runStart == nil {
            let n = normalized.count
            if n >= 5 {
                for windowSize in 5...n {
                    let windowStart = n - windowSize
                    let uniqueCount = Set(normalized[windowStart...]).count
                    if uniqueCount <= 2 {
                        runStart = windowStart
                        break
                    }
                }
            }
        }

        guard let start = runStart else { return (text, false) }

        if start == 0 {
            // Nothing precedes the repetition — keep the first occurrence only
            // so we never return an empty string.
            let kept = String(text[text.startIndex..<nonBlank[0].range.upperBound])
            return (kept, true)
        }

        let cutIndex = nonBlank[start].range.lowerBound
        let kept = String(text[text.startIndex..<cutIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
        if kept.isEmpty {
            let fallback = String(text[text.startIndex..<nonBlank[0].range.upperBound])
            return (fallback, true)
        }
        return (kept, true)
    }
}
