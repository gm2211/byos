/** Bounded HTTP/1.1 framing for the certificate-validated TLS stream. No redirects or compression. */
const MAX_HEADERS = 32 * 1024;
const MAX_BODY = 16 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const bad = () => new Error('OpenAI returned an invalid or incomplete HTTP response.');

export class CodexHttpStream {
  private buffer = new Uint8Array(0);
  private headersSeen = false;
  private mode: 'length' | 'chunked' | 'close' = 'close';
  private remaining = 0;
  private chunkRemaining: number | null = null;
  private chunkTerminator = false;
  private trailers = false;
  private bytes = 0;
  private interimResponses = 0;
  done = false;
  private readonly handlers: {
    headers: (status: number, headers: Headers) => void;
    data: (bytes: Uint8Array) => void;
    end: () => void;
  };
  constructor(handlers: CodexHttpStream['handlers']) { this.handlers = handlers; }

  push(bytes: Uint8Array): void {
    if (this.done) { if (bytes.length) throw bad(); return; }
    const next = new Uint8Array(this.buffer.length + bytes.length);
    next.set(this.buffer); next.set(bytes, this.buffer.length); this.buffer = next;
    while (!this.done) {
      if (!this.headersSeen) {
        const boundary = this.find([13, 10, 13, 10]);
        if (boundary < 0) { if (this.buffer.length > MAX_HEADERS) throw bad(); return; }
        if (boundary > MAX_HEADERS) throw bad();
        const lines = decoder.decode(this.take(boundary + 4)).slice(0, -4).split('\r\n');
        const status = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(lines.shift() ?? '');
        if (!status) throw bad();
        const code = Number(status[1]);
        const headers = new Headers();
        const seen = new Set<string>();
        for (const line of lines) {
          const match = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(line);
          if (!match) throw bad();
          const key = match[1].toLowerCase();
          if (seen.has(key) && ['content-length', 'transfer-encoding', 'content-encoding'].includes(key)) throw bad();
          seen.add(key); headers.append(key, match[2]);
        }
        if (code === 100) { if (++this.interimResponses > 4) throw bad(); continue; }
        if (code < 200) throw bad();
        const length = headers.get('content-length'), transfer = headers.get('transfer-encoding');
        if (length !== null && transfer !== null) throw bad();
        if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity') throw bad();
        if (transfer !== null && transfer.toLowerCase() !== 'chunked') throw bad();
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw bad();
        this.mode = transfer ? 'chunked' : length !== null ? 'length' : 'close';
        this.remaining = Number(length ?? 0);
        this.headersSeen = true;
        this.handlers.headers(code, headers);
        if (code === 204 || code === 205 || code === 304 || (this.mode === 'length' && this.remaining === 0)) this.finish();
      } else if (this.mode === 'chunked') {
        if (this.trailers) {
          // Empty trailers are the normal Responses path. Bounded trailers are consumed, never merged.
          if (this.buffer[0] === 13 && this.buffer[1] === 10) { this.take(2); this.finish(); continue; }
          const end = this.find([13, 10, 13, 10]);
          if (end < 0) { if (this.buffer.length > MAX_HEADERS) throw bad(); return; }
          if (end > MAX_HEADERS) throw bad();
          this.take(end + 4); this.finish(); continue;
        }
        if (this.chunkTerminator) {
          if (this.buffer.length < 2) return;
          if (this.buffer[0] !== 13 || this.buffer[1] !== 10) throw bad();
          this.take(2); this.chunkTerminator = false; this.chunkRemaining = null;
        }
        if (this.chunkRemaining === null) {
          const end = this.find([13, 10]);
          if (end < 0) { if (this.buffer.length > 1024) throw bad(); return; }
          if (end > 1024) throw bad();
          const line = decoder.decode(this.take(end + 2)).slice(0, -2);
          if (!/^[\da-fA-F]+(?:;[^\r\n]*)?$/.test(line)) throw bad();
          this.chunkRemaining = Number.parseInt(line.split(';')[0], 16);
          if (!Number.isSafeInteger(this.chunkRemaining) || this.chunkRemaining > MAX_BODY - this.bytes) throw bad();
          if (this.chunkRemaining === 0) { this.trailers = true; continue; }
        }
        if (!this.buffer.length) return;
        const size = Math.min(this.chunkRemaining, this.buffer.length);
        this.emit(this.take(size)); this.chunkRemaining -= size;
        if (this.chunkRemaining === 0) this.chunkTerminator = true;
      } else {
        if (!this.buffer.length) return;
        const size = this.mode === 'length' ? Math.min(this.remaining, this.buffer.length) : this.buffer.length;
        this.emit(this.take(size));
        if (this.mode === 'length') { this.remaining -= size; if (!this.remaining) this.finish(); }
      }
    }
  }

  eof(authenticatedClose: boolean): void {
    if (this.done) return;
    if (!authenticatedClose || !this.headersSeen || this.mode !== 'close') throw bad();
    this.finish();
  }

  private emit(bytes: Uint8Array): void {
    this.bytes += bytes.length;
    if (this.bytes > MAX_BODY) throw bad();
    if (bytes.length) this.handlers.data(bytes);
  }
  private finish(): void {
    if (this.buffer.length) throw bad();
    this.done = true; this.handlers.end();
  }
  private take(n: number): Uint8Array {
    const result = this.buffer.slice(0, n); this.buffer = this.buffer.slice(n); return result;
  }
  private find(pattern: number[]): number {
    outer: for (let i = 0; i <= this.buffer.length - pattern.length; i++) {
      for (let j = 0; j < pattern.length; j++) if (this.buffer[i + j] !== pattern[j]) continue outer;
      return i;
    }
    return -1;
  }
}
