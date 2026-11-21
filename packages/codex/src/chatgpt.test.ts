// Built output: the sources use NodeNext `.js` imports, so tests run against dist/.
// Synthetic tokens and responses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatgpt, chatgptCodeSignInAvailable, chatgptCredentialPath, encodeChatGptPlanCredential, encodeCodexCredential } from '../dist/index.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const far = Date.now() + 3_600_000;
const officialToken = encodeChatGptPlanCredential({ accessToken: 'plan-at', refreshToken: 'plan-rt', clientId: 'oaiapp_x', expiresAt: far });
const codeToken = encodeCodexCredential({ accessToken: 'code-at', refreshToken: 'code-rt', accountId: 'acct', expiresAt: far });

function setup(relayOn: boolean | null) {
  const hits: string[] = [];
  const codeFetch = async (input: string | URL) => { hits.push(`code ${input}`); return json(200, { models: [{ slug: 'gpt-code', display_name: 'Code model', visibility: 'list', supported_in_api: true }] }); };
  const planFetch = async (input: string | URL) => { hits.push(`official ${input}`); return json(200, { data: [{ id: 'gpt-plan' }] }); };
  const provider = chatgpt({
    code: { fetch: codeFetch, readCredential: () => null, saveCredential: () => undefined, unavailableReason: () => (relayOn ? undefined : 'No relay here.') },
    official: { appName: 'demo', fetch: planFetch, readCredential: () => null, saveCredential: () => undefined },
  });
  return { provider, hits };
}

test('chatgpt lists the code sign-in first and the official sign-in as the fallback', () => {
  const { provider } = setup(true);
  assert.equal(provider.id, 'chatgpt');
  assert.deepEqual(provider.signIn.map(m => m.kind), ['device-code', 'pkce']);
  assert.equal(provider.webSearch, true);
});

test('chatgpt stays available through the official path when the relay is off', () => {
  assert.deepEqual(setup(true).provider.availability(), { available: true });
  assert.deepEqual(setup(false).provider.availability(), { available: true });
  assert.equal(chatgptCodeSignInAvailable({ code: { fetch: fetch, readCredential: () => null, saveCredential: () => undefined, unavailableReason: () => 'off' } }), false);
});

test('chatgpt sends each credential to the adapter that made it', async () => {
  assert.equal(chatgptCredentialPath(officialToken), 'official');
  assert.equal(chatgptCredentialPath(codeToken), 'code');
  const { provider, hits } = setup(true);
  await provider.listModels(officialToken).catch(() => undefined);
  await provider.listModels(codeToken).catch(() => undefined);
  assert.ok(hits[0]?.startsWith('official '), hits.join('\n'));
  assert.ok(hits.at(-1)?.startsWith('code '), hits.join('\n'));
  assert.ok(!hits.some(h => h.startsWith('official ') && h.includes('chatgpt.com')));
});
