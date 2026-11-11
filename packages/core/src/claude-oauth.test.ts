import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CLAUDE_AUTHORIZE_URL, CLAUDE_CODE_SYSTEM_PREFIX, CLAUDE_OAUTH_BETA, CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_SCOPE,
  CLAUDE_PASTE_REDIRECT_URI, CLAUDE_TOKEN_URL, buildClaudeTokenRequest, claudeAuthorizeUrl, claudeCodeChallenge,
  classifyClaudeRefreshFailure, filterClaudeTokenResponse, readClaudePastedCode,
} from '../dist/index.js';

const v = JSON.parse(readFileSync(new URL('../conformance/claude-oauth.json', import.meta.url), 'utf8'));

test('Claude constants match the vectors', () => {
  assert.equal(CLAUDE_OAUTH_CLIENT_ID, v.constants.clientId);
  assert.equal(CLAUDE_AUTHORIZE_URL, v.constants.authorizeUrl);
  assert.equal(CLAUDE_TOKEN_URL, v.constants.tokenUrl);
  assert.equal(CLAUDE_OAUTH_SCOPE, v.constants.scope);
  assert.equal(CLAUDE_PASTE_REDIRECT_URI, v.constants.pasteRedirectUri);
  assert.equal(CLAUDE_OAUTH_BETA, v.constants.oauthBeta);
  assert.equal(CLAUDE_CODE_SYSTEM_PREFIX, v.constants.claudeCodeSystemPrefix);
});

test('PKCE challenge and authorize URL match the vectors', async () => {
  assert.equal(await claudeCodeChallenge(v.pkce.verifier), v.pkce.challenge);
  assert.equal(claudeAuthorizeUrl(v.authorize), v.authorize.url);
});

for (const c of v.pasted) {
  test(`pasted code: ${c.name}`, () => {
    assert.deepEqual(readClaudePastedCode(c.input, v.expectedState), c.expect);
  });
}

test('token request bodies match the vectors', () => {
  for (const c of v.tokenRequests) assert.deepEqual(buildClaudeTokenRequest(c.input), c.body);
});

test('token responses keep what the vectors keep', () => {
  for (const c of v.tokenResponses) {
    const filtered = filterClaudeTokenResponse(c.payload);
    if (c.expect === null) { assert.equal(filtered, undefined, c.name); continue; }
    assert.equal(filtered?.access_token, c.expect.accessToken, c.name);
    if (c.payload.refresh_token) assert.equal(filtered?.refresh_token, c.expect.refreshToken, c.name);
    assert.equal(filtered?.account?.email_address, c.expect.accountEmail, c.name);
  }
});

test('refresh failures classify like the vectors', () => {
  for (const c of v.refreshFailures) assert.equal(classifyClaudeRefreshFailure(c.status), c.expect);
});
