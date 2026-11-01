/**
 * Fixed-destination relay for Anthropic's OAuth token endpoint (Claude Pro/Max subscriptions).
 * platform.claude.com/v1/oauth/token refuses browser origins (CORS), while api.anthropic.com accepts
 * Bearer calls from pages. So a browser app cannot run the authorization-code exchange or a refresh
 * grant itself; this relay forwards exactly those two grant shapes and nothing else.
 *
 * TOKEN RULE (Claude exception, approved 2026-11-01): the authorization-code exchange and each refresh
 * grant pass through this relay. It neither stores nor logs them, forwards only to the fixed
 * destination `CLAUDE_TOKEN_URL`, and returns only a filtered token response. Inference stays
 * browser -> api.anthropic.com and never touches the host. The relay sees grants and tokens in
 * transit, so mount it only where that is disclosed to the user.
 *
 * MOUNT ORDER: this router parses its own body with a route-local `express.raw`, so mount it BEFORE any
 * global `express.json()`/`urlencoded()`; a body already parsed upstream is rejected (400).
 *
 * The site supplies allowed origins, a release gate, the route prefix and, optionally, its own
 * session lookup. Live acceptance by Anthropic of the paste-code flow is unverified.
 */
import type { IncomingMessage } from 'node:http';
import express from 'express';
import {
  CLAUDE_TOKEN_URL,
  filterClaudeTokenResponse,
  validateClaudeTokenRequest,
  type ClaudeTokenResponse,
} from '@byos/core';

const MAX_BODY_BYTES = 4 * 1024;
const MAX_UPSTREAM_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const RATE_WINDOW_MS = 60_000;
const MAX_PER_KEY_PER_WINDOW = 20;
const MAX_GLOBAL_PER_WINDOW = 300;
const MAX_RATE_BUCKETS = 10_000;

export type ClaudeRelaySession = { ownerKey: string };

export type ClaudeTokenRelayOptions = {
  /** Route prefix, e.g. `/api/ai/claude`. Serves `GET ${basePath}/status` and `POST ${basePath}/token`. */
  basePath: string;
  /** Browser origins allowed to call the relay (exact origins, https in prod). */
  allowedOrigins: () => Set<string>;
  /** The release gate; the relay refuses everything while this is false. */
  enabled: () => boolean;
  /** Maps the site's own session token to an account. Omit to serve any allowed origin (rate limited by address). */
  resolveSession?: (session: string) => Promise<ClaudeRelaySession | undefined>;
  /** Reads the site's session from the request (for example a signed cookie). Needs `resolveSession`; not with `sessionHeader`. */
  readSession?: (request: IncomingMessage) => string | undefined;
  /** Request header carrying the site's session token. Needs `resolveSession`; not with `readSession`. */
  sessionHeader?: string;
  /** Test seam; production uses the global fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  /** User-facing wording; defaults are generic. */
  messages?: Partial<typeof DEFAULT_MESSAGES>;
};

const DEFAULT_MESSAGES = {
  unavailable: 'Claude sign-in is unavailable.',
  originRejected: 'This browser origin is not allowed.',
  contentType: 'Send the grant as JSON.',
  tooLarge: 'The request is too large.',
  signIn: 'Sign in to use your Claude plan.',
  tooMany: 'Too many Claude sign-in attempts. Try again shortly.',
  invalid: 'The request is not a valid Claude sign-in grant.',
  upstream: 'Claude sign-in could not be completed. Try again.',
};

export type ClaudeRelayInput = {
  origin?: string;
  secFetchSite?: string;
  contentType?: string;
  /** The raw request body, or anything else when a parser upstream already consumed it. */
  body: unknown;
  /** Set when body parsing failed: `large` (over the cap) or `bad`. */
  bodyError?: 'large' | 'bad';
  session?: string;
  /** Rate-limit key when there is no session lookup (for example the client address). */
  address?: string;
};

export type ClaudeRelayResult = { status: number; body: Record<string, unknown> };

function normalizeBasePath(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[?#\\]/.test(value) || value.includes('//')) {
    throw new TypeError('basePath must be a same-origin absolute path with safe segments.');
  }
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = trimmed.slice(1).split('/');
  if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) {
    throw new TypeError('basePath must be a same-origin absolute path with safe segments.');
  }
  return `/${segments.join('/')}`;
}

async function readCapped(response: Response, limit: number): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => undefined); return undefined; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
}

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export function createClaudeTokenRelay(options: ClaudeTokenRelayOptions) {
  const { allowedOrigins, enabled: featureEnabled, resolveSession, readSession, sessionHeader } = options;
  const base = normalizeBasePath(options.basePath);
  if (resolveSession) {
    if ((typeof sessionHeader === 'string') === (typeof readSession === 'function')) {
      throw new TypeError('Configure exactly one of sessionHeader or readSession with resolveSession.');
    }
  } else if (sessionHeader !== undefined || readSession !== undefined) {
    throw new TypeError('sessionHeader and readSession need resolveSession.');
  }
  if (sessionHeader !== undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(sessionHeader)) {
    throw new TypeError('sessionHeader must be a valid HTTP header name.');
  }
  const messages = { ...DEFAULT_MESSAGES, ...options.messages };
  const upstreamFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { startedAt: number; count: number }>();
  let globalBucket = { startedAt: now(), count: 0 };

  const fail = (status: number, error: string): ClaudeRelayResult => ({ status, body: { error } });

  /** Checks that need no body, in the documented order. */
  function precheck(input: ClaudeRelayInput): ClaudeRelayResult | undefined {
    if (!featureEnabled()) return fail(503, messages.unavailable);
    if (!input.origin || !allowedOrigins().has(input.origin)) return fail(403, messages.originRejected);
    if (input.secFetchSite !== undefined && input.secFetchSite !== 'same-origin') return fail(403, messages.originRejected);
    if (!/^application\/json\s*(;|$)/i.test(input.contentType ?? '')) return fail(415, messages.contentType);
    return undefined;
  }

  function charge(key: string): boolean {
    const current = now();
    for (const [bucketKey, bucket] of buckets) if (current - bucket.startedAt >= RATE_WINDOW_MS) buckets.delete(bucketKey);
    if (current - globalBucket.startedAt >= RATE_WINDOW_MS) globalBucket = { startedAt: current, count: 0 };
    const bucket = buckets.get(key);
    if (!bucket && buckets.size >= MAX_RATE_BUCKETS) return false;
    if (globalBucket.count >= MAX_GLOBAL_PER_WINDOW || (bucket && bucket.count >= MAX_PER_KEY_PER_WINDOW)) return false;
    globalBucket.count++;
    if (bucket) bucket.count++; else buckets.set(key, { startedAt: current, count: 1 });
    return true;
  }

  async function upstream(grant: unknown): Promise<ClaudeRelayResult> {
    let response: Response;
    try {
      response = await upstreamFetch(CLAUDE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(grant),
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch { return fail(502, messages.upstream); }
    try {
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        return fail(response.status, 'invalid_grant');
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return fail(502, messages.upstream);
      }
      const filtered: ClaudeTokenResponse | undefined = filterClaudeTokenResponse(await readCapped(response, MAX_UPSTREAM_BYTES));
      return filtered ? { status: 200, body: filtered } : fail(502, messages.upstream);
    } catch { return fail(502, messages.upstream); }
  }

  /** The whole token route as a pure function of the collected request facts. Never logs. */
  async function handle(input: ClaudeRelayInput): Promise<ClaudeRelayResult> {
    const early = precheck(input);
    if (early) return early;
    if (input.bodyError === 'large') return fail(413, messages.tooLarge);
    if (!Buffer.isBuffer(input.body) || input.bodyError) return fail(400, messages.invalid);
    if (input.body.length > MAX_BODY_BYTES) return fail(413, messages.tooLarge);
    let key = `address:${input.address ?? 'unknown'}`;
    if (resolveSession) {
      const session = input.session;
      if (typeof session !== 'string' || session.length === 0 || session.length > 512) return fail(401, messages.signIn);
      let account: ClaudeRelaySession | undefined;
      try { account = await resolveSession(session); } catch { return fail(503, messages.unavailable); }
      if (!account?.ownerKey) return fail(401, messages.signIn);
      key = `owner:${account.ownerKey}`;
    }
    if (!charge(key)) return fail(429, messages.tooMany);
    let parsed: unknown;
    try { parsed = JSON.parse(input.body.toString('utf8')); } catch { return fail(400, messages.invalid); }
    const grant = validateClaudeTokenRequest(parsed);
    if (!grant) return fail(400, messages.invalid);
    return upstream(grant);
  }

  function send(res: express.Response, result: ClaudeRelayResult): void {
    res.set(NO_STORE_HEADERS).status(result.status).json(result.body);
  }

  const router = express.Router();
  router.get(`${base}/status`, (_req, res) => {
    res.set(NO_STORE_HEADERS).json({ enabled: featureEnabled() });
  });

  const rawBody = express.raw({ type: () => true, limit: MAX_BODY_BYTES });
  router.post(
    `${base}/token`,
    // Gate, origin, fetch-metadata and content-type are decided before any body is read.
    (req, res, next) => {
      const early = precheck({ origin: req.get('Origin'), secFetchSite: req.get('Sec-Fetch-Site'), contentType: req.get('Content-Type'), body: undefined });
      if (early) { send(res, early); return; }
      next();
    },
    (req, res, next) => {
      // A parser mounted ahead of this router already consumed the stream; never trust its output.
      if (req.body !== undefined && !Buffer.isBuffer(req.body) && (req as { _body?: boolean })._body) { send(res, fail(400, messages.invalid)); return; }
      rawBody(req, res, error => {
        if (error) {
          const type = (error as { type?: string }).type;
          send(res, fail(type === 'entity.too.large' ? 413 : 400, type === 'entity.too.large' ? messages.tooLarge : messages.invalid));
          return;
        }
        next();
      });
    },
    async (req, res) => {
      let session: string | undefined;
      if (resolveSession) {
        try { session = readSession ? readSession(req) : req.get(sessionHeader!); }
        catch { send(res, fail(503, messages.unavailable)); return; }
      }
      send(res, await handle({
        origin: req.get('Origin'),
        secFetchSite: req.get('Sec-Fetch-Site'),
        contentType: req.get('Content-Type'),
        body: req.body,
        session,
        address: req.ip,
      }));
    },
  );

  return { router, handle };
}
