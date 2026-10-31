import { createServer, type Server } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { ClaudeError, checkSignal } from './errors.js';

/**
 * Claude Pro/Max sign-in: OAuth 2.0 authorization code + PKCE against the public Claude Code client.
 * The endpoints, client id and scopes are the ones the Claude CLI uses. They are undocumented but have
 * been stable across CLI versions. Ported from the Skim app's working claude_oauth.rs.
 */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const SCOPE = 'user:profile user:inference';
/** The client only accepts http://localhost:<port>/callback; 127.0.0.1 is rejected as an unsupported redirect URI. */
export const LOOPBACK_PORT = 54134;
export const LOOPBACK_PATH = '/callback';
/** Console page that displays a `CODE#STATE` string for the user to copy back (paste fallback). */
export const PASTE_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

export type Pkce = { verifier: string; challenge: string; state: string; redirectUri: string };
export function newPkce(redirectUri: string): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url'), redirectUri };
}
export function authorizeUrl(p: Pkce): string {
  const u = new URL(AUTHORIZE_URL);
  for (const [k, v] of Object.entries({ code: 'true', client_id: CLIENT_ID, response_type: 'code', redirect_uri: p.redirectUri, scope: SCOPE, code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state })) u.searchParams.set(k, v);
  return u.href;
}
/** Accepts `CODE#STATE` (as the console page shows it) or a bare code. */
export function parsePastedCode(pasted: string, p: Pkce): string {
  const [code, state = p.state] = pasted.trim().split('#');
  if (!code || code.length > 4096 || /\s/.test(code) || state !== p.state) throw new ClaudeError('auth-failed');
  return code;
}

const same = (a: string | null, b: string) => !!a && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Binds the loopback callback (IPv4, plus IPv6 when available because `localhost` can resolve to either),
 * reports the authorization URL through `openBrowser`, and resolves with the authorization code.
 */
export async function loopbackAuthorize(options: { openBrowser: (url: string) => void | Promise<void>; signal?: AbortSignal; port?: number; timeoutMs?: number }) {
  checkSignal(options.signal);
  let pkce!: Pkce, settled = false;
  let resolve!: (code: string) => void, reject!: (e: ClaudeError) => void;
  const callback = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  void callback.catch(() => {});
  const fail = (code: 'auth-failed' | 'canceled') => { if (!settled) { settled = true; reject(new ClaudeError(code)); } };
  const handler: Parameters<typeof createServer>[1] = (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    const port = (servers[0].address() as { port: number }).port;
    if (settled || req.method !== 'GET' || (req.url?.length ?? 0) > 8192 || ![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(req.headers.host ?? '')) { res.writeHead(400).end('Invalid callback.'); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://localhost:${port}`); } catch { res.writeHead(400).end('Invalid callback.'); return; }
    // Browsers also ask for /favicon.ico and open speculative connections; only the callback counts.
    if (url.pathname !== LOOPBACK_PATH) { res.writeHead(404).end('Not found.'); return; }
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !same(url.searchParams.get('state'), pkce.state) || !code || code.length > 4096) {
      res.writeHead(400).end('Sign-in could not be verified.'); fail('auth-failed'); return;
    }
    settled = true;
    res.end("<html><body style='font-family:system-ui;padding:48px;text-align:center'><h2>Signed in to Claude</h2><p>You can close this window and return to the app.</p></body></html>", () => resolve(code));
  };
  const servers: Server[] = [createServer(handler)];
  const timer = setTimeout(() => fail('canceled'), options.timeoutMs ?? 5 * 60_000);
  const aborted = () => fail('canceled');
  options.signal?.addEventListener('abort', aborted, { once: true });
  try {
    try { await new Promise<void>((yes, no) => { servers[0].once('error', no); servers[0].listen(options.port ?? LOOPBACK_PORT, '127.0.0.1', () => { servers[0].off('error', no); yes(); }); }); }
    catch { throw new ClaudeError('port-in-use'); }
    const port = (servers[0].address() as { port: number }).port;
    const v6 = createServer(handler);
    try { await new Promise<void>((yes, no) => { v6.once('error', no); v6.listen(port, '::1', () => { v6.off('error', no); yes(); }); }); servers.push(v6); } catch { v6.close(); }
    pkce = newPkce(`http://localhost:${port}${LOOPBACK_PATH}`);
    checkSignal(options.signal);
    await Promise.race([Promise.resolve().then(() => options.openBrowser(authorizeUrl(pkce))), callback.then(() => undefined)]);
    const code = await callback; checkSignal(options.signal);
    return { code, pkce };
  } catch (e) { checkSignal(options.signal); if (e instanceof ClaudeError) throw e; throw new ClaudeError('auth-failed'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); for (const s of servers) { s.close(); s.closeAllConnections(); } }
}
