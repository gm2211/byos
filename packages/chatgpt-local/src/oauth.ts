import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { ChatGptError, checkSignal } from './errors.js';
import { ISSUER, AUTHORIZE, RESOURCE, SCOPES, authEndpoint, request, ensureOk, json, text } from './http.js';

export async function discover(fetcher: typeof fetch, signal?: AbortSignal) {
  const r = await request(fetcher, `${ISSUER}/.well-known/openid-configuration`, {}, signal); await ensureOk(r);
  const value = await json(r);
  if (value.issuer !== ISSUER) throw new ChatGptError('auth-failed');
  return { jwks: authEndpoint(value.jwks_uri), revocation: authEndpoint(value.revocation_endpoint) };
}
export async function verifyIdentity(fetcher: typeof fetch, token: string, clientId: string, nonce: string | undefined, now: number, signal?: AbortSignal) {
  try {
    const metadata = await discover(fetcher, signal);
    const r = await request(fetcher, metadata.jwks, {}, signal); await ensureOk(r);
    const jwks = await json(r);
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 100) throw new ChatGptError('auth-failed');
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
      issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'], currentDate: new Date(now), requiredClaims: ['sub', 'exp', 'iat'],
    });
    if (!text(payload.sub, 512) || (nonce !== undefined && payload.nonce !== nonce)) throw new ChatGptError('auth-failed');
    return { subject: payload.sub, email: text(payload.email, 256) ? payload.email : undefined };
  } catch { checkSignal(signal); throw new ChatGptError('auth-failed'); }
}

export async function authorize(options: {
  appName: string; hostId: string; clientId?: string; enablePlan?: boolean;
  openBrowser: (url: string) => void | Promise<void>; signal?: AbortSignal;
}) {
  checkSignal(options.signal);
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  let resolve!: (value: { code: string; clientId: string }) => void;
  let reject!: (error: ChatGptError) => void;
  const callback = new Promise<{ code: string; clientId: string }>((yes, no) => { resolve = yes; reject = no; });
  // An opener can itself await a callback request; handle early rejection immediately.
  void callback.catch(() => {});
  let settled = false, authority = '';
  const fail = (code: 'auth-failed' | 'canceled') => { if (!settled) { settled = true; reject(new ChatGptError(code)); } };
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (settled || req.method !== 'GET' || req.headers.host !== authority || (req.url?.length ?? 0) > 8192) { res.writeHead(400).end('Invalid callback.'); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${authority}`); }
    catch { res.writeHead(400).end('Invalid callback.'); return; }
    if (url.pathname !== '/auth/callback' || url.origin !== `http://${authority}`) { res.writeHead(404).end('Not found.'); return; }
    const equal = (got: string | null) => !!got && Buffer.byteLength(got) === Buffer.byteLength(state) && timingSafeEqual(Buffer.from(got), Buffer.from(state));
    if (['state', 'code', 'client_id', 'error'].some(k => url.searchParams.getAll(k).length > 1) || !equal(url.searchParams.get('state'))) {
      res.writeHead(400).end('Sign-in could not be verified.'); fail('auth-failed'); return;
    }
    if (url.searchParams.has('error')) { res.writeHead(400).end('Sign-in was not completed.'); fail('auth-failed'); return; }
    const code = url.searchParams.get('code'), supplied = url.searchParams.get('client_id');
    const clientId = supplied ?? options.clientId;
    if (!text(code, 4096) || !text(clientId, 512) || clientId === 'dynamic_agent_client' || (options.clientId && clientId !== options.clientId)) {
      res.writeHead(400).end('Sign-in could not be verified.'); fail('auth-failed'); return;
    }
    settled = true; res.end('Authorization received. Return to the app to finish connecting.', () => resolve({ code, clientId }));
  });
  const aborted = () => fail('canceled');
  const timer = setTimeout(() => fail('canceled'), 5 * 60_000);
  options.signal?.addEventListener('abort', aborted, { once: true });
  try {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => { server.off('error', no); yes(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw new ChatGptError('auth-failed');
    authority = `127.0.0.1:${address.port}`;
    const redirectUri = `http://${authority}/auth/callback`;
    const url = new URL(AUTHORIZE);
    const params: Record<string, string> = {
      client_id: options.clientId ?? 'dynamic_agent_client', ext_agent_host_id: options.hostId,
      response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE,
      state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
    if (!options.clientId) params.agent_name_hint = options.appName;
    if (options.enablePlan) params.prompt = 'consent';
    // Omit optional id_token_hint: opener implementations may pass this public URL in argv.
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    checkSignal(options.signal);
    await Promise.race([Promise.resolve().then(() => options.openBrowser(url.href)), callback.then(() => undefined)]);
    const result = await callback; checkSignal(options.signal);
    return { ...result, verifier, nonce, redirectUri };
  } catch (error) { checkSignal(options.signal); if (error instanceof ChatGptError) throw error; throw new ChatGptError('auth-failed'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); server.close(); server.closeAllConnections(); }
}
