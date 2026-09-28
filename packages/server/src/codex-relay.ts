/**
 * Ciphertext-only relay for browser-owned TLS to OpenAI (Codex subscriptions). The browser runs
 * its own TLS (rustls WASM) to auth.openai.com / chatgpt.com; this relay only moves the encrypted
 * bytes over a WebSocket to those two FIXED hosts. It never terminates TLS, never sees tokens,
 * headers or bodies, and a site cannot pass a host, URL or port.
 *
 * TOKEN RULE: provider credentials never reach the site's server; only ciphertext and connection
 * metadata (destination, peer address, timing, sizes, the site's own session) pass through here.
 *
 * Extracted unchanged in behavior from Motive's server/src/codex-tunnel.ts; the site supplies the
 * session lookup, allowed origins, release gate, route prefix and session header.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net, { BlockList, isIP, Socket } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const HOSTS = { auth: 'auth.openai.com', responses: 'chatgpt.com' } as const;
type Destination = keyof typeof HOSTS;
type Ticket = {
  session: string;
  ownerKey: string;
  origin: string;
  destination: Destination;
  expiresAt: number;
};

const TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 4_000;
const MAX_RATE_BUCKETS = 10_000;
const MAX_TICKETS_PER_MINUTE = 60;
const MAX_GLOBAL_TICKETS_PER_MINUTE = 600;
const MAX_ACTIVE_GLOBAL = 64;
const MAX_ACTIVE_PER_ACCOUNT = 3;
const BYTE_WINDOW_MS = 10 * 60_000;
const MAX_ACCOUNT_BYTES_PER_WINDOW = 128 * 1024 * 1024;
const MAX_GLOBAL_BYTES_PER_WINDOW = 512 * 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_WS_QUEUE_BYTES = 512 * 1024;
const MAX_TCP_QUEUE_BYTES = 512 * 1024;
// Leave room above the browser HTTP body cap for TLS headers and record framing.
const MAX_CLIENT_BYTES = 17 * 1024 * 1024;
const MAX_SERVER_BYTES = 17 * 1024 * 1024;
const MAX_LIFETIME_MS = 10 * 60_000;
const IDLE_TIMEOUT_MS = 60_000;
const TICKET_FRAME_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 20_000;

const blockedAddresses = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(subnet, prefix, 'ipv4');
for (const [subnet, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['2001::', 23], ['2002::', 16], ['3fff::', 20],
] as const) blockedAddresses.addSubnet(subnet, prefix, 'ipv6');

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedAddresses.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return publicAddress(mapped[1]);
  // Globally routed IPv6 unicast currently occupies 2000::/3. Everything outside it is
  // rejected, then the special-use and transition ranges above are rejected separately.
  const first = parseInt(address.split(':')[0] || '0', 16);
  return (first & 0xe000) === 0x2000 && !blockedAddresses.check(address, 'ipv6');
}

function normalizedAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

function ticketKey(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

function bytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: number, reason: string): void {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

function validDestination(value: unknown): value is Destination {
  return value === 'auth' || value === 'responses';
}

function dialPinned(_host: string, target: { address: string; family: number }, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.address, family: target.family, port: 443 });
    const timeout = setTimeout(() => socket.destroy(new Error('connect_timeout')), timeoutMs);
    const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
    socket.once('error', fail);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.removeListener('error', fail);
      if (normalizedAddress(socket.remoteAddress) !== normalizedAddress(target.address)) {
        socket.destroy();
        reject(new Error('peer_mismatch'));
        return;
      }
      resolve(socket);
    });
  });
}

export type AccountSession = { ownerKey: string };

export type CodexRelayOptions = {
  /** Maps the site's own session token to an account. Only signed-in visitors may open a tunnel;
   * `ownerKey` scopes rate and byte limits. */
  resolveSession: (session: string) => Promise<AccountSession | undefined>;
  /** Browser origins allowed to request tickets and open tunnels (exact origins, https in prod). */
  allowedOrigins: () => Set<string>;
  /** The release gate; the relay refuses everything while this is false. */
  enabled: () => boolean;
  /** Route prefix, e.g. `/api/ai/codex-tunnel` (Motive's). Tunnels live at `${basePath}/auth` and
   * `${basePath}/responses`; tickets at `${basePath}/ticket`. */
  basePath: string;
  /** Request header carrying the site's session token on ticket requests. */
  sessionHeader: string;
  /** User-facing wording; defaults name Codex. */
  messages?: Partial<typeof DEFAULT_MESSAGES>;
  lookupAddresses?: (host: string) => Promise<{ address: string; family: number }[]>;
  connect?: (host: string, target: { address: string; family: number }, timeoutMs: number) => Promise<Socket>;
  now?: () => number;
  /** Narrow deterministic test seams; production construction uses the fixed constants above. */
  idleTimeoutMs?: number;
  maxAccountBytesPerWindow?: number;
  maxGlobalBytesPerWindow?: number;
};

const DEFAULT_MESSAGES = {
  unavailable: 'Codex browser transport is unavailable.',
  originRejected: 'This browser origin is not allowed.',
  signIn: 'Sign in to use Codex browser transport.',
  destination: 'A valid Codex destination is required.',
  busy: 'Codex browser transport is busy.',
  tooMany: 'Too many Codex transport attempts. Try again shortly.',
};

/** Implements only the outer WSS-to-TCP byte transport. It never reads TLS records or provider HTTP. */
export function createCodexRelay(options: CodexRelayOptions) {
  const { resolveSession, allowedOrigins, enabled: featureEnabled } = options;
  const messages = { ...DEFAULT_MESSAGES, ...options.messages };
  const base = options.basePath.replace(/\/$/, '');
  const PATHS = { auth: `${base}/auth`, responses: `${base}/responses` } as const;
  const lookupAddresses = options.lookupAddresses ?? (async host => {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('destination_unavailable');
    return addresses.map(({ address, family }) => ({ address, family }));
  });
  const connect = options.connect ?? dialPinned;
  const now = options.now ?? Date.now;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const maxAccountBytesPerWindow = options.maxAccountBytesPerWindow ?? MAX_ACCOUNT_BYTES_PER_WINDOW;
  const maxGlobalBytesPerWindow = options.maxGlobalBytesPerWindow ?? MAX_GLOBAL_BYTES_PER_WINDOW;
  const tickets = new Map<string, Ticket>();
  const ticketRates = new Map<string, { startedAt: number; count: number }>();
  const accountByteWindows = new Map<string, { startedAt: number; bytes: number }>();
  const activeByOwner = new Map<string, number>();
  const clients = new Set<WebSocket>();
  const upstreams = new Set<Socket>();
  let accepting = true;
  let activeConnections = 0;
  let globalTicketRate = { startedAt: now(), count: 0 };
  let globalByteWindow = { startedAt: now(), bytes: 0 };

  function chargeBytes(ownerKey: string, byteCount: number): boolean {
    const current = now();
    if (current - globalByteWindow.startedAt >= BYTE_WINDOW_MS) globalByteWindow = { startedAt: current, bytes: 0 };
    for (const [owner, window] of accountByteWindows) {
      if (current - window.startedAt >= BYTE_WINDOW_MS) accountByteWindows.delete(owner);
    }
    let accountWindow = accountByteWindows.get(ownerKey);
    if (!accountWindow) {
      if (accountByteWindows.size >= MAX_RATE_BUCKETS) return false;
      accountWindow = { startedAt: current, bytes: 0 };
      accountByteWindows.set(ownerKey, accountWindow);
    }
    if (globalByteWindow.bytes + byteCount > maxGlobalBytesPerWindow
      || accountWindow.bytes + byteCount > maxAccountBytesPerWindow) return false;
    globalByteWindow.bytes += byteCount;
    accountWindow.bytes += byteCount;
    return true;
  }

  const router = express.Router();
  router.get(`${base}/status`, (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ enabled: accepting && featureEnabled() });
  });
  router.post(`${base}/ticket`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!accepting || !featureEnabled()) { res.status(503).json({ error: messages.unavailable }); return; }
    const origin = req.get('Origin');
    if (!origin || !allowedOrigins().has(origin)) { res.status(403).json({ error: messages.originRejected }); return; }
    const session = req.get(options.sessionHeader);
    if (!session || session.length > 512) { res.status(401).json({ error: messages.signIn }); return; }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).length !== 1 || !validDestination(req.body.destination)) {
      res.status(400).json({ error: messages.destination }); return;
    }
    let account: AccountSession | undefined;
    try { account = await resolveSession(session); } catch { res.status(503).json({ error: messages.unavailable }); return; }
    if (!account?.ownerKey) { res.status(401).json({ error: messages.signIn }); return; }

    const current = now();
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= current) tickets.delete(key);
    for (const [key, rate] of ticketRates) if (current - rate.startedAt >= 60_000) ticketRates.delete(key);
    if (tickets.size >= MAX_TICKETS) { res.status(503).json({ error: messages.busy }); return; }
    const rate = ticketRates.get(account.ownerKey);
    if (rate && rate.count >= MAX_TICKETS_PER_MINUTE) { res.status(429).json({ error: messages.tooMany }); return; }
    if (!rate && ticketRates.size >= MAX_RATE_BUCKETS) { res.status(503).json({ error: messages.busy }); return; }
    if (current - globalTicketRate.startedAt >= 60_000) globalTicketRate = { startedAt: current, count: 0 };
    if (globalTicketRate.count >= MAX_GLOBAL_TICKETS_PER_MINUTE) { res.status(429).json({ error: messages.tooMany }); return; }
    globalTicketRate.count++;
    if (rate) rate.count++;
    else ticketRates.set(account.ownerKey, { startedAt: current, count: 1 });
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = current + TICKET_TTL_MS;
    tickets.set(ticketKey(ticket), { session, ownerKey: account.ownerKey, origin, destination: req.body.destination, expiresAt });
    res.json({ ticket, expiresAt });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, clientTracking: false });

  function handleClient(ws: WebSocket, destination: Destination, origin: string): void {
    clients.add(ws);
    let phase: 'ticket' | 'connecting' | 'ready' | 'closed' = 'ticket';
    let accountOwner: string | undefined;
    let upstream: Socket | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = now();
    const ticketTimer = setTimeout(() => ws.terminate(), TICKET_FRAME_TIMEOUT_MS);
    const closeTimer = setTimeout(() => { closeUpstream(); ws.terminate(); }, MAX_LIFETIME_MS);
    let clientBytes = 0;
    let serverBytes = 0;
    const pendingServerFrames: Buffer[] = [];
    let pendingServerBytes = 0;
    let tcpPaused = false;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { closeUpstream(); ws.terminate(); }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const releaseOwner = () => {
      if (!accountOwner) return;
      const remaining = (activeByOwner.get(accountOwner) ?? 1) - 1;
      if (remaining <= 0) activeByOwner.delete(accountOwner); else activeByOwner.set(accountOwner, remaining);
      activeConnections = Math.max(0, activeConnections - 1);
      accountOwner = undefined;
    };
    const closeUpstream = () => {
      phase = 'closed';
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(ticketTimer);
      clearTimeout(closeTimer);
      if (upstream) { upstreams.delete(upstream); upstream.destroy(); upstream = undefined; }
      releaseOwner();
    };
    const fail = () => { if (ws.readyState === WebSocket.OPEN) ws.close(1008, 'transport unavailable'); closeUpstream(); };
    const isClosed = () => phase === 'closed';
    const pauseTcp = () => upstream?.pause();
    const resumeTcp = () => { if (ws.readyState === WebSocket.OPEN && pendingServerFrames.length === 0) upstream?.resume(); };
    const flushServerFrames = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      while (pendingServerFrames.length > 0) {
        const pending = pendingServerFrames[0];
        if (ws.bufferedAmount + pending.length > MAX_WS_QUEUE_BYTES) return;
        pendingServerFrames.shift();
        pendingServerBytes -= pending.length;
        ws.send(pending, { binary: true }, error => {
          if (error) { fail(); return; }
          flushServerFrames();
          resumeTcp();
        });
      }
      resumeTcp();
    };
    const sendServerFrame = (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += MAX_FRAME_BYTES) {
        const frame = chunk.subarray(offset, Math.min(offset + MAX_FRAME_BYTES, chunk.length));
        if (pendingServerFrames.length > 0 || ws.bufferedAmount + frame.length > MAX_WS_QUEUE_BYTES) {
          if (ws.bufferedAmount + pendingServerBytes + frame.length > MAX_WS_QUEUE_BYTES) { fail(); return; }
          pendingServerFrames.push(Buffer.from(frame));
          pendingServerBytes += frame.length;
          pauseTcp();
          continue;
        }
        ws.send(frame, { binary: true }, error => {
          if (error) { fail(); return; }
          flushServerFrames();
          resumeTcp();
        });
      }
    };
    resetIdle();
    ticketTimer.unref?.();
    closeTimer.unref?.();

    ws.on('message', (data, binary) => {
      if (phase === 'ticket') {
        const frame = bytes(data);
        if (binary || frame.byteLength > 2048) { fail(); return; }
        phase = 'connecting';
        let payload: unknown;
        try { payload = JSON.parse(frame.toString()); } catch { fail(); return; }
        const value = payload as { ticket?: unknown; version?: unknown };
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
          || value.version !== 1 || typeof value.ticket !== 'string' || value.ticket.length > 128) { fail(); return; }
        clearTimeout(ticketTimer);
        const hash = ticketKey(value.ticket);
        const ticket = tickets.get(hash);
        tickets.delete(hash);
        void (async () => {
          if (!ticket || ticket.expiresAt <= now() || ticket.origin !== origin || ticket.destination !== destination) throw new Error('ticket_invalid');
          const account = await resolveSession(ticket.session);
          if (!account?.ownerKey || account.ownerKey !== ticket.ownerKey) throw new Error('session_expired');
          if ((activeByOwner.get(account.ownerKey) ?? 0) >= MAX_ACTIVE_PER_ACCOUNT || activeConnections >= MAX_ACTIVE_GLOBAL) throw new Error('limit');
          accountOwner = account.ownerKey;
          activeByOwner.set(accountOwner, (activeByOwner.get(accountOwner) ?? 0) + 1);
          activeConnections++;
          const host = HOSTS[destination];
          let lookupTimer: ReturnType<typeof setTimeout> | undefined;
          let addresses: { address: string; family: number }[];
          try {
            addresses = await Promise.race([
              lookupAddresses(host),
              new Promise<never>((_resolve, reject) => { lookupTimer = setTimeout(() => reject(new Error('dns_timeout')), CONNECT_TIMEOUT_MS); }),
            ]);
          } finally { if (lookupTimer) clearTimeout(lookupTimer); }
          if (isClosed() || now() - startedAt > MAX_LIFETIME_MS) throw new Error('connection_closed');
          if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('destination_unavailable');
          let connected: Socket | undefined;
          let lastError: unknown;
          const connectStartedAt = now();
          for (const target of addresses.slice(0, 8)) {
            if (isClosed() || now() - startedAt > MAX_LIFETIME_MS) throw new Error('connection_closed');
            const remainingMs = CONNECT_TIMEOUT_MS - (now() - connectStartedAt);
            if (remainingMs <= 0) break;
            try { connected = await connect(host, target, remainingMs); break; } catch (error) { lastError = error; }
          }
          if (!connected) throw lastError ?? new Error('destination_unavailable');
          if (isClosed() || ws.readyState !== WebSocket.OPEN || !accepting) { connected.destroy(); return; }
          upstream = connected;
          upstreams.add(upstream);
          upstream.setNoDelay(true);
          upstream.setTimeout(idleTimeoutMs);
          upstream.once('timeout', fail);
          upstream.on('data', (chunk: Buffer) => {
            if (phase !== 'ready') { fail(); return; }
            serverBytes += chunk.length;
            if (serverBytes > MAX_SERVER_BYTES || now() - startedAt > MAX_LIFETIME_MS
              || !accountOwner || !chargeBytes(accountOwner, chunk.length)) { fail(); return; }
            resetIdle();
            sendServerFrame(chunk);
          });
          upstream.on('end', () => {
            closeUpstream();
            if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'upstream ended');
          });
          upstream.on('error', fail);
          upstream.on('close', () => { if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'upstream closed'); closeUpstream(); });
          resetIdle();
          ws.send(JSON.stringify({ ready: true, version: 1 }), error => {
            if (error) { fail(); return; }
            if (phase === 'connecting') {
              phase = 'ready';
            }
          });
        })().catch(fail);
        return;
      }
      const frame = bytes(data);
      if (phase !== 'ready' || !binary || frame.byteLength < 1 || frame.byteLength > MAX_FRAME_BYTES || !upstream) { fail(); return; }
      clientBytes += frame.byteLength;
      if (clientBytes > MAX_CLIENT_BYTES || now() - startedAt > MAX_LIFETIME_MS
        || upstream.writableLength + frame.byteLength > MAX_TCP_QUEUE_BYTES
        || !accountOwner || !chargeBytes(accountOwner, frame.byteLength)) { fail(); return; }
      resetIdle();
      if (!upstream.write(frame)) {
        tcpPaused = true;
        // ws exposes the underlying TCP socket as _socket; pause only reads, never relay writes.
        (ws as WebSocket & { _socket?: Socket })._socket?.pause();
        upstream.once('drain', () => {
          if (tcpPaused && ws.readyState === WebSocket.OPEN) {
            tcpPaused = false;
            (ws as WebSocket & { _socket?: Socket })._socket?.resume();
          }
        });
      }
    });
    ws.on('close', () => { clients.delete(ws); closeUpstream(); });
    ws.on('error', closeUpstream);
  }

  function handleUpgrade(server: Server) {
    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const path = req.url;
      const destination = path === PATHS.auth ? 'auth' : path === PATHS.responses ? 'responses' : undefined;
      const origin = req.headers.origin;
      if (!accepting || !featureEnabled()) { rejectUpgrade(socket, 503, 'Service Unavailable'); return; }
      if (!destination || typeof origin !== 'string' || !allowedOrigins().has(origin)) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
      if (req.headers['sec-websocket-protocol']) { rejectUpgrade(socket, 400, 'Bad Request'); return; }
      if (clients.size >= MAX_ACTIVE_GLOBAL) { rejectUpgrade(socket, 503, 'Service Unavailable'); return; }
      wss.handleUpgrade(req, socket, head, ws => handleClient(ws, destination, origin));
    });
  }

  function close(): void {
    accepting = false;
    for (const socket of upstreams) socket.destroy();
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.close(1001, 'server draining');
      else client.terminate();
    }
    const finish = setTimeout(() => { for (const client of clients) client.terminate(); }, 1_000);
    finish.unref?.();
  }

  return { router, handleUpgrade, close };
}
