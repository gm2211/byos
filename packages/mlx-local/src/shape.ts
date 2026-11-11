import type { ChatEvent } from '@byos/core';

/** Leading reasoning blocks: Qwen-style `<think>` and Gemma 4's `<|channel>`. */
const REASONING_BLOCKS: ReadonlyArray<readonly [string, string]> = [['<think>', '</think>'], ['<|channel>', '<channel|>']];

/** Length of the longest suffix of `text` that starts one of `markers` (and is not all of it). */
function partialSuffix(text: string, markers: readonly string[]): number {
  let best = 0;
  for (const marker of markers) {
    for (let length = Math.min(marker.length - 1, text.length); length > best; length--) {
      if (marker.startsWith(text.slice(text.length - length))) { best = length; break; }
    }
  }
  return best;
}

/**
 * Turns raw model text into chat events while it streams: leading reasoning blocks become
 * `reasoning` events, end-of-turn markers and anything after them are dropped, and
 * surrounding whitespace is trimmed. Text that might be the start of a marker is held back
 * until the next chunk settles it, so nothing is emitted that would have to be taken back.
 */
export class StreamShaper {
  private buffer = '';
  private mode: 'lead' | 'reasoning' | 'answer' | 'stopped' = 'lead';
  private closer = '';
  private answerStarted = false;

  private readonly stops: readonly string[];

  constructor(stops: readonly string[]) {
    this.stops = stops;
  }

  push(chunk: string): ChatEvent[] {
    if (this.mode === 'stopped') return [];
    this.buffer += chunk;
    return this.drain(false);
  }

  end(): ChatEvent[] {
    if (this.mode === 'stopped') return [];
    const events = this.drain(true);
    this.mode = 'stopped';
    return events;
  }

  private drain(final: boolean): ChatEvent[] {
    const events: ChatEvent[] = [];
    while (true) {
      if (this.mode === 'lead') {
        this.buffer = this.buffer.trimStart();
        const block = REASONING_BLOCKS.find(([open]) => this.buffer.startsWith(open));
        if (block) {
          this.buffer = this.buffer.slice(block[0].length);
          this.closer = block[1];
          this.mode = 'reasoning';
          continue;
        }
        if (!final && (this.buffer === '' || REASONING_BLOCKS.some(([open]) => open.startsWith(this.buffer)))) return events;
        this.mode = 'answer';
        continue;
      }
      if (this.mode === 'reasoning') {
        const close = this.buffer.indexOf(this.closer);
        if (close >= 0) {
          const text = this.buffer.slice(0, close);
          if (text) events.push({ type: 'reasoning', text });
          this.buffer = this.buffer.slice(close + this.closer.length);
          this.mode = 'lead';
          continue;
        }
        const keep = final ? 0 : partialSuffix(this.buffer, [this.closer]);
        const text = this.buffer.slice(0, this.buffer.length - keep);
        if (text) events.push({ type: 'reasoning', text });
        this.buffer = this.buffer.slice(text.length);
        return events;
      }
      if (this.mode === 'answer') {
        let stopAt = -1;
        for (const stop of this.stops) {
          const index = this.buffer.indexOf(stop);
          if (index >= 0 && (stopAt < 0 || index < stopAt)) stopAt = index;
        }
        let ready: string;
        if (stopAt >= 0) {
          ready = this.buffer.slice(0, stopAt).trimEnd();
          this.buffer = '';
          this.mode = 'stopped';
        } else if (final) {
          ready = this.buffer.trimEnd();
          this.buffer = '';
        } else {
          const keep = partialSuffix(this.buffer, this.stops);
          ready = this.buffer.slice(0, this.buffer.length - keep).trimEnd();
          this.buffer = this.buffer.slice(ready.length);
        }
        if (!this.answerStarted) ready = ready.trimStart();
        if (ready) {
          this.answerStarted = true;
          events.push({ type: 'text', text: ready });
        }
        return events;
      }
      return events;
    }
  }
}
