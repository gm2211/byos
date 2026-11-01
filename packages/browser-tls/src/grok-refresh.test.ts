// End to end: the Grok refresh request built by @byos/providers must pass the browser-tls
// `xai-auth` validation and header allowlist, so a browser refresh works through the ciphertext relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrokSubscription, encodeGrokCredential } from '../../providers/dist/index.js';
import { validateCodexRequest } from '../dist/transport.js';

test('Grok refresh from @byos/providers is a valid xai-auth browser-tls request', async () => {
  let stored = encodeGrokCredential({ accessToken: 'at-1', refreshToken: 'synthetic-refresh-1', expiresAt: Date.now() + 1_000 });
  const seen: Array<{ destination: string; method: string; headers: string[]; body: string }> = [];
  const subscription = createGrokSubscription({
    tokenFetch: async (input, init) => {
      const { destination, method } = validateCodexRequest(input, init);
      seen.push({ destination, method, headers: [...new Headers(init.headers).keys()], body: String(init.body) });
      return new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }), { status: 200 });
    },
    readCredential: () => stored,
    saveCredential: value => { stored = value; },
  });
  assert.equal(await subscription.accessToken(stored), 'at-2');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].destination, 'xai-auth');
  assert.equal(seen[0].method, 'POST');
  // Exactly the headers the xai-auth destination allows.
  assert.deepEqual(seen[0].headers.sort(), ['accept', 'content-type']);
  assert.ok(['accept', 'content-type'].every(name => seen[0].headers.includes(name)));
  assert.match(seen[0].body, /^grant_type=refresh_token&refresh_token=synthetic-refresh-1&client_id=/);
});
