/** Trims the repetition loops small (often on-device) models fall into, shared by TypeScript and
 *  ByosCore Swift. Ported from Skim's NativeAI.degenerateRepetitionTrim; vectors in
 *  conformance/text-polish.json. TypeScript counts code points where Swift counts characters, so the
 *  two agree on text without combining sequences. */

type Chunk = { start: number; end: number; text: string };

/** Sentence chunks over code points; joined back together they rebuild the text exactly. */
function sentenceChunks(chars: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => { chunks.push({ start, end, text: chars.slice(start, end).join('') }); start = end; i = end; };
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\n') { push(i + 1); continue; }
    if (c === '.' || c === '!' || c === '?') {
      if (i + 1 < chars.length && chars[i + 1] === ' ') { push(i + 2); continue; }
      if (i + 1 === chars.length) { push(i + 1); continue; }
    }
    i += 1;
  }
  if (start < chars.length) chunks.push({ start, end: chars.length, text: chars.slice(start).join('') });
  return chunks;
}

const normalize = (sentence: string) => sentence.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');

/** The text cut to one copy of a trailing unit (12 to 400 characters) repeated at least 4 times. */
function trimTrailingSubstringLoop(chars: string[]): string | undefined {
  const n = chars.length;
  if (n < 48) return undefined;
  const maxPeriod = Math.min(Math.floor(n / 4), 400);
  if (maxPeriod < 12) return undefined;
  const same = (a: number, b: number, length: number) => { for (let k = 0; k < length; k++) if (chars[a + k] !== chars[b + k]) return false; return true; };
  for (let period = 12; period <= maxPeriod; period++) {
    const tailStart = n - period * 4;
    if (tailStart < 0) break;
    if (chars.slice(tailStart, tailStart + period).every(c => /\s/.test(c))) continue;
    let repeating = true;
    for (let k = 1; k < 4; k++) if (!same(tailStart, tailStart + k * period, period)) { repeating = false; break; }
    if (!repeating) continue;
    let loopStart = tailStart;
    while (loopStart - period >= 0 && same(loopStart - period, tailStart, period)) loopStart -= period;
    return chars.slice(0, loopStart + period).join('');
  }
  return undefined;
}

/**
 * Detects and trims degenerate repetitive output. Degenerate when the same sentence appears 3 or more
 * times in a row, when the last 5 or more sentences hold at most 2 different ones, or when the text ends
 * with a 12+ character unit repeated 4 or more times back to back. The text is cut where the repetition
 * starts; when nothing precedes it, the first occurrence is kept, so non-empty input never comes back empty.
 */
export function trimDegenerateRepetition(text: string): { text: string; wasDegenerate: boolean } {
  if (!text) return { text, wasDegenerate: false };
  const chars = Array.from(text);
  const looped = trimTrailingSubstringLoop(chars);
  if (looped) return { text: looped, wasDegenerate: true };

  const nonBlank = sentenceChunks(chars).filter(chunk => normalize(chunk.text));
  if (nonBlank.length < 3) return { text, wasDegenerate: false };
  const normalized = nonBlank.map(chunk => normalize(chunk.text));

  let runStart: number | undefined;
  for (let i = 0; i < normalized.length;) {
    let j = i;
    while (j + 1 < normalized.length && normalized[j + 1] === normalized[i]) j += 1;
    if (j - i + 1 >= 3) { runStart = i; break; }
    i = j + 1;
  }
  if (runStart === undefined && normalized.length >= 5) {
    for (let window = 5; window <= normalized.length; window++) {
      const windowStart = normalized.length - window;
      if (new Set(normalized.slice(windowStart)).size <= 2) { runStart = windowStart; break; }
    }
  }
  if (runStart === undefined) return { text, wasDegenerate: false };

  const firstOnly = chars.slice(0, nonBlank[0]!.end).join('');
  if (runStart === 0) return { text: firstOnly, wasDegenerate: true };
  const kept = chars.slice(0, nonBlank[runStart]!.start).join('').trim();
  return { text: kept || firstOnly, wasDegenerate: true };
}
