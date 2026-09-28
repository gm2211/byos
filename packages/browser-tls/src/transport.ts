/**
 * Browser-owned TLS to OpenAI for Codex subscriptions. The page runs rustls (WASM) itself and sends
 * only TLS ciphertext through the site's relay (@byos/server createCodexRelay) to two fixed hosts.
 * Only the Codex sign-in, refresh, account catalog and Responses routes are allowed.
 *
 * Extracted from Motive's web/src/codex-tls-transport.ts with behavior unchanged; the site supplies
 * the engine loader, its session, the relay path and header, and its client label.
 */
import { CodexHttpStream } from './http-stream.js';

const MAX_BODY = 16 * 1024 * 1024;
const MAX_QUEUE = 512 * 1024;
const encoder = new TextEncoder();
export class CodexTransportError extends Error {
  readonly code: 'connection-failed' | 'relay-unreachable' | 'relay-rejected';
  readonly status?: number;
  constructor(
    message = 'The encrypted Codex connection failed. Try again.',
    code: 'connection-failed' | 'relay-unreachable' | 'relay-rejected' = 'connection-failed',
    status?: number,
  ) { super(message); this.name = 'CodexTransportError'; this.code = code; this.status = status; }
}

/** Only these HTTPS operations may receive a browser-held provider credential. */
export function validateCodexRequest(input: string | URL, init: RequestInit = {}): { url: URL; destination: 'auth' | 'responses'; method: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw new CodexTransportError('Unsupported Codex endpoint.'); }
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw new CodexTransportError('Unsupported Codex endpoint.');
  const auth = url.hostname === 'auth.openai.com' && method === 'POST' && !url.search
    && ['/api/accounts/deviceauth/usercode', '/api/accounts/deviceauth/token', '/oauth/token'].includes(url.pathname);
  const response = url.hostname === 'chatgpt.com' && method === 'POST' && url.pathname === '/backend-api/codex/responses' && !url.search;
  const catalog = url.hostname === 'chatgpt.com' && method === 'GET' && url.pathname === '/backend-api/codex/models'
    && /^\?client_version=\d+\.\d+\.\d+$/.test(url.search);
  if ((!auth && !response && !catalog) || (init.redirect && init.redirect !== 'error')) throw new CodexTransportError('Unsupported Codex endpoint.');
  return { url, destination: auth ? 'auth' : 'responses', method };
}


async function readTicket(response: Response): Promise<{ ticket: string; expiresAt: number }> {
  const reader = response.body?.getReader();
  if (!reader) throw new CodexTransportError();
  let text = '', size = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_048) throw new CodexTransportError();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const grant = JSON.parse(text);
    if (typeof grant?.ticket !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(grant.ticket)
      || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt)
      || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 60_000) throw new CodexTransportError();
    return grant;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new CodexTransportError();
  } finally { reader.releaseLock(); }
}

/** The rustls WASM engine as wasm-bindgen exports it (see browser-tls/src/lib.rs). */
export interface BrowserTlsEngine {
  free(): void;
  ready(): boolean;
  closed(): boolean;
  receive(bytes: Uint8Array): number;
  outgoing(): Uint8Array;
  plaintext(): Uint8Array;
  write(bytes: Uint8Array): number;
}
export type BrowserTlsModule = { BrowserTls: new (host: string) => BrowserTlsEngine };

export type CodexTlsFetchOptions = {
  /** Loads the reviewed rustls WASM build; the site bundles the artifact itself. */
  loadEngine: () => Promise<BrowserTlsModule>;
  /** The site's session token for the relay's ticket route, or null when signed out. */
  getSession: () => { session: string; expiresAt: number } | null | undefined;
  /** Must match the relay's basePath (@byos/server createCodexRelay). */
  relayBasePath: string;
  /** Must match the relay's sessionHeader. */
  sessionHeader: string;
  /** Appended to the User-Agent, e.g. "Motive browser TLS". */
  clientLabel: string;
  messages?: Partial<typeof DEFAULT_MESSAGES>;
};

const DEFAULT_MESSAGES = {
  signIn: 'Sign in before connecting your Codex subscription.',
  insecure: 'A secure connection to this site is required.',
};

/**
 * Builds a fetch() for the allowed Codex endpoints that runs TLS inside the browser and sends only
 * ciphertext through the site's relay. TOKEN RULE: credentials, headers and bodies are encrypted
 * before they leave the page; the relay never sees them.
 */
export function createCodexTlsFetch(options: CodexTlsFetchOptions) {
  const messages = { ...DEFAULT_MESSAGES, ...options.messages };
  const base = options.relayBasePath.replace(/\/$/, '');
  return async function codexTlsFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const { url, destination, method } = validateCodexRequest(input, init);
    init.signal?.throwIfAborted();
    if (init.body != null && typeof init.body !== 'string') throw new CodexTransportError('Unsupported Codex request body.');
    if (method === 'GET' && init.body != null) throw new CodexTransportError('Unsupported Codex request body.');
    const body = encoder.encode(init.body as string ?? '');
    if (body.length > MAX_BODY) throw new CodexTransportError('This Codex request is too large.');
    let headers: Headers;
    try { headers = new Headers(init.headers); } catch { throw new CodexTransportError('Unsupported Codex request header.'); }
    for (const name of headers.keys()) {
      if (!['authorization', 'content-type', 'accept', 'chatgpt-account-id', 'originator', 'openai-beta'].includes(name)) {
        throw new CodexTransportError('Unsupported Codex request header.');
      }
    }
    headers.set('Host', url.hostname);
    headers.set('Connection', 'close');
    headers.set('Accept-Encoding', 'identity');
    headers.set('User-Agent', `codex_cli_rs/0.153.2 (${options.clientLabel})`);
    // Keep the upstream Codex protocol identity/version consistent with the account catalog.
    // User-Agent still identifies this browser implementation (clientLabel).
    headers.set('Originator', 'codex_cli_rs');
    headers.set('Version', '0.153.2');
    if (method === 'POST') headers.set('Content-Length', String(body.length));
    const head = encoder.encode(`${method} ${url.pathname}${url.search} HTTP/1.1\r\n${Array.from(headers, ([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
    if (head.length > 32 * 1024) throw new CodexTransportError('This Codex request is too large.');
    const session = options.getSession();
    if (!session || session.expiresAt <= Date.now()) throw new CodexTransportError(messages.signIn);
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(10 * 60_000)]);
    const [tls, ticketResponse] = await Promise.all([
      options.loadEngine(),
      fetch(`${base}/ticket`, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', [options.sessionHeader]: session.session },
        body: JSON.stringify({ destination }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      }).catch(() => {
        signal.throwIfAborted();
        throw new CodexTransportError('The encrypted Codex relay could not be reached. Check the connection and try again.', 'relay-unreachable');
      }),
    ]);
    if (!ticketResponse.ok) {
      await ticketResponse.body?.cancel();
      throw new CodexTransportError(ticketResponse.status === 401
        ? messages.signIn
        : ticketResponse.status === 429
          ? 'Codex is limiting connection attempts. Wait a moment, then retry.'
          : ticketResponse.status === 503
            ? 'Codex browser connections are unavailable here. You can still paste a CLI token in Service.'
            : 'Encrypted Codex connections are unavailable right now.', 'relay-rejected', ticketResponse.status);
    }
    const grant = await readTicket(ticketResponse);
    signal.throwIfAborted();
    const wsUrl = new URL(`${base}/${destination}`, location.href);
    wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (wsUrl.protocol === 'ws:' && !['127.0.0.1', 'localhost'].includes(wsUrl.hostname)) throw new CodexTransportError(messages.insecure);
    let engine: BrowserTlsEngine | null = new tls.BrowserTls(url.hostname);
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl); } catch { engine.free(); throw new CodexTransportError(); }
    ws.binaryType = 'arraybuffer';
    let acknowledged = false, sent = false, stopped = false, resolved = false;
    let requestHead: Uint8Array | null = head, requestBody: Uint8Array | null = body;
    let stream: ReadableStreamDefaultController<Uint8Array>;
    let rejectResponse: (reason: Error) => void;
    let resolveResponse: (response: Response) => void;
    const result = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) { stream = controller; },
      cancel() { stop(); },
    }, { highWaterMark: 128 * 1024, size: chunk => chunk.byteLength });
    // A response may fail before the caller gets its stream. Avoid an unhandled rejection then.
    let idle = setTimeout(() => fail(), 20_000);
    const handshake = setTimeout(() => { if (!sent) fail(); }, 20_000);
    function stop() {
      if (stopped) return;
      stopped = true; clearTimeout(idle); clearTimeout(handshake); signal.removeEventListener('abort', abort);
      requestHead = null; requestBody = null;
      ws.onmessage = null; ws.onerror = null; ws.onclose = null; ws.onopen = null;
      try { ws.close(); } catch { /* Still free TLS state if a browser rejects closing CONNECTING. */ }
      engine?.free(); engine = null;
    }
    function fail(error: Error = new CodexTransportError()) {
      if (stopped) return;
      if (!resolved) rejectResponse(error);
      else stream.error(error);
      stop();
    }
    function abort() { fail(new DOMException('The Codex request was cancelled.', 'AbortError')); }
    function flush() {
      if (!engine || stopped) return;
      const bytes = engine.outgoing();
      if (ws.bufferedAmount + bytes.length > MAX_QUEUE) throw new CodexTransportError('The encrypted connection is too slow. Try again.');
      for (let i = 0; i < bytes.length; i += 64 * 1024) ws.send(bytes.slice(i, i + 64 * 1024));
    }
    async function writeRequest() {
      try {
        for (const bytes of [requestHead, requestBody]) {
          if (!bytes) continue;
          let offset = 0;
          while (offset < bytes.length) {
            if (stopped || !engine) return;
            if (ws.bufferedAmount > 256 * 1024) { await new Promise(r => setTimeout(r, 10)); continue; }
            const n = engine.write(bytes.subarray(offset, Math.min(offset + 16 * 1024, bytes.length)));
            if (!n) throw new CodexTransportError();
            offset += n; flush();
          }
        }
        requestHead = null; requestBody = null;
      } catch { fail(); }
    }
    const parser = new CodexHttpStream({
      headers(status, responseHeaders) {
        if (status >= 300 && status < 400) throw new CodexTransportError('OpenAI redirected this request; no credentials were forwarded.');
        const response = new Response(status === 204 || status === 205 ? null : bodyStream, { status, headers: responseHeaders });
        resolved = true;
        resolveResponse(response);
      },
      data(bytes) {
        if ((stream.desiredSize ?? 0) < -MAX_QUEUE) throw new CodexTransportError('The Codex response exceeded the browser buffer limit.');
        stream.enqueue(bytes);
      },
      end() { stream.close(); stop(); },
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    ws.onopen = () => { if (!stopped) { ws.send(JSON.stringify({ ticket: grant.ticket, version: 1 })); grant.ticket = ''; } };
    ws.onmessage = event => {
      if (stopped || !engine) return;
      try {
        clearTimeout(idle); idle = setTimeout(() => fail(), 60_000);
        if (!acknowledged) {
          if (typeof event.data !== 'string' || event.data.length > 256) throw new CodexTransportError();
          const ack = JSON.parse(event.data);
          if (ack.ready !== true || ack.version !== 1) throw new CodexTransportError();
          acknowledged = true; flush(); return;
        }
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 64 * 1024) throw new CodexTransportError();
        const incoming = new Uint8Array(event.data);
        for (let offset = 0; offset < incoming.length && engine && !stopped;) {
          // read_tls may accept only part of one WebSocket frame. Retain its suffix and
          // drain decrypted bytes before feeding more so rustls backpressure stays bounded.
          const consumed = engine.receive(incoming.subarray(offset));
          if (!Number.isInteger(consumed) || consumed <= 0 || consumed > incoming.length - offset) throw new CodexTransportError();
          offset += consumed;
          flush();
          if (engine.ready() && !sent) { sent = true; clearTimeout(handshake); void writeRequest(); }
          while (engine && !stopped) {
            const bytes = engine.plaintext();
            if (!bytes.length) break;
            parser.push(bytes);
          }
          if (engine?.closed() && !stopped) parser.eof(true);
        }
      } catch { fail(); }
    };
    ws.onerror = () => fail();
    ws.onclose = () => {
      if (stopped) return;
      try { parser.eof(engine?.closed() ?? false); } catch { fail(); }
    };
    return result;
  };
}
