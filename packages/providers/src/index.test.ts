import assert from 'node:assert/strict';
import test from 'node:test';
// Built output: sources use NodeNext `.js` imports.
import { classifyProviderError, listModelsForEndpoint, listOpenRouterModels, OpenRouterAuthenticationError, ProviderRequestError, claudeAcceptsTemperature, endpointFor, grok, groq, isChatModel, NOT_RECOMMENDED_REASON, openrouter, orderServices, parseSseLine, parseXaiResponsesPayload, streamChatCompletions, type ServiceKey } from '../dist/index.js';

type Call = { url: string; init?: RequestInit };
function fakeFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

function sse(lines: string[]): Response {
  return new Response(new Blob([lines.map(line => `${line}\n`).join('')]).stream(), { status: 200 });
}

test('endpoints are browser-direct provider hosts; OpenRouter carries the site title', () => {
  const or = endpointFor('openrouter', 'k', { appTitle: 'Garden', referer: 'https://garden.example' });
  assert.equal(or.baseUrl, 'https://openrouter.ai/api/v1');
  assert.deepEqual(or.headers, { 'HTTP-Referer': 'https://garden.example', 'X-OpenRouter-Title': 'Garden' });
  assert.equal(endpointFor('xai', 'k').webSearch, 'xai-responses-web-search');
  assert.equal(endpointFor('groq', 'k').webSearch, 'none');
});

test('chat streams text, reasoning and usage, and sends the token only to the provider', async () => {
  const calls = fakeFetch(() => sse([
    ': keepalive',
    'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    'data: [DONE]',
  ]));
  const events = [];
  for await (const event of groq().stream('secret', { model: 'm', messages: [{ role: 'user', content: 'hi' }], effort: 'low' })) events.push(event);
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo' },
    { type: 'usage', inputTokens: 3, outputTokens: 2, costUsd: undefined },
    { type: 'done' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer secret');
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(JSON.parse(String(calls[0].init?.body)).reasoning_effort, 'low');
});

test('chat surfaces a provider refusal with its status and redacts an echoed credential', async () => {
  fakeFetch(() => new Response(JSON.stringify({ code: 'x', error: 'Incorrect API key: bad-secret' }), { status: 401 }));
  await assert.rejects(async () => {
    for await (const _ of streamChatCompletions(endpointFor('xai', 'bad-secret'), { model: 'm', messages: [] })) { /* drain */ }
  }, (error: Error & { status?: number }) => error.message === 'Incorrect API key: [redacted]' && error.status === 401);
});

test('chat cancels provider stream when consumer stops early', async () => {
  let canceled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
    },
    cancel() { canceled = true; },
  }))) as typeof fetch;
  for await (const _event of streamChatCompletions(endpointFor('groq', 'key'), { model: 'm', messages: [] })) break;
  assert.equal(canceled, true);
});

test('model lists come from the provider', async () => {
  const calls = fakeFetch(({ url }) => url.endsWith('/models') && url.includes('x.ai')
    ? new Response(JSON.stringify({ data: [{ id: 'grok-b' }, { id: 'grok-a', name: 'Grok A' }] }))
    : new Response(JSON.stringify({ data: [{ id: 'good', name: 'GPT-5.6', supported_parameters: ['tools'] }, { id: 'no-tools' }] })));
  assert.deepEqual(await grok().listModels('k'), [{ id: 'grok-b', name: 'grok-b' }, { id: 'grok-a', name: 'Grok A' }]);
  assert.deepEqual(await openrouter().listModels('k'), [{ id: 'good', name: 'GPT-5.6', recommended: true }]);
  assert.ok(calls.every(call => call.init?.redirect === 'error'));
});

test('model lists drop repeats and non-chat models', async () => {
  fakeFetch(() => new Response(JSON.stringify({ data: [
    { id: 'grok-4.7', created: 1790000000 },
    { id: 'grok-4.20-0309-reasoning', created: 1773000000 },
    { id: 'grok-imagine-image-2.0' },
    { id: 'grok-4.3', created: 1776000000 },
    { id: 'grok-imagine-video-1.5-lite' },
    { id: 'grok-4.7' },
    { id: 'grok-build-0.1' },
  ] })));
  assert.deepEqual((await grok().listModels('k')).map(model => model.id), ['grok-4.7', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-build-0.1']);
});

test('model lists put the newest flagship first and dated variants below it', async () => {
  // xAI answers /models alphabetically, which puts the older 4.20 builds above 4.7.
  fakeFetch(() => new Response(JSON.stringify({ data: [
    { id: 'grok-4.20-0309-non-reasoning', created: 1773000000 },
    { id: 'grok-4.20-0309-reasoning', created: 1773000000 },
    { id: 'grok-4.20-multi-agent-0309', created: 1773000000 },
    { id: 'grok-4.3', created: 1776000000 },
    { id: 'grok-4.5', created: 1781000000 },
    { id: 'grok-4.6', created: 1785000000 },
    { id: 'grok-4.7-1015', created: 1790000000 },
    { id: 'grok-4.7', created: 1790000000 },
  ] })));
  assert.deepEqual((await grok().listModels('k')).map(model => model.id), [
    'grok-4.7', 'grok-4.7-1015', 'grok-4.6', 'grok-4.5', 'grok-4.3',
    'grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning', 'grok-4.20-multi-agent-0309',
  ]);
});

const GROK_IDS = ['grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning', 'grok-4.20-multi-agent-0309', 'grok-4.3', 'grok-4.5', 'grok-4.6', 'grok-4.7'];
const GROK_NEWEST_FIRST = ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning', 'grok-4.20-multi-agent-0309'];

test('model lists without created put undated builds first, newest version first, then dated variants', async () => {
  fakeFetch(() => new Response(JSON.stringify({ data: GROK_IDS.map(id => ({ id })) })));
  assert.deepEqual((await grok().listModels('k')).map(model => model.id), GROK_NEWEST_FIRST);
});

test('model lists with created timestamps give the same order', async () => {
  const created: Record<string, number> = { 'grok-4.3': 1776000000, 'grok-4.5': 1781000000, 'grok-4.6': 1785000000, 'grok-4.7': 1790000000 };
  fakeFetch(() => new Response(JSON.stringify({ data: GROK_IDS.map(id => ({ id, created: created[id] ?? 1773000000 })) })));
  assert.deepEqual((await grok().listModels('k')).map(model => model.id), GROK_NEWEST_FIRST);
});

test('non-chat models are recognized by id words, not substrings', () => {
  for (const id of ['grok-4.7', 'grok-build-0.1', 'llama-3.2-11b-vision-instruct', 'gpt-5', 'qwen3-32b']) assert.equal(isChatModel(id), true, id);
  for (const id of ['grok-imagine-image', 'grok-imagine-video-1.5', 'dall-e-3', 'gpt-image-1', 'text-embedding-3-small', 'whisper-large-v3', 'playai-tts', 'omni-moderation-latest', 'imagen-4.0-generate-001', 'gemini-2.5-flash-image-preview', 'nano-banana-pro', 'veo-3.0-generate-preview', 'lyria-realtime']) assert.equal(isChatModel(id), false, id);
});

test('provider model discovery forwards cancellation signal', async () => {
  const calls = fakeFetch(() => new Response(JSON.stringify({ data: [{ id: 'm' }] })));
  const controller = new AbortController();
  await groq().listModels('k', controller.signal);
  assert.equal(calls[0].init?.signal, controller.signal);
  assert.equal(calls[0].init?.redirect, 'error');
});

test('model discovery redacts credentials echoed in provider errors', async () => {
  fakeFetch(() => new Response(JSON.stringify({ error: { message: 'Rejected secret-key' } }), { status: 401 }));
  await assert.rejects(() => grok().listModels('secret-key'), /Rejected \[redacted\]/);
});

test('sign-in methods disclose when the site server is involved', () => {
  assert.deepEqual(openrouter().signIn, [{ kind: 'pkce', handshakeViaSite: false }]);
  assert.equal(grok().signIn[0].kind, 'device-code');
  assert.equal(grok({ deviceCodeViaSite: false }).signIn[0].kind, 'api-key');
});

test('moved helpers keep their behavior', () => {
  assert.equal(parseSseLine('data: [DONE]'), null);
  const parsed = parseXaiResponsesPayload({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{}', annotations: [{ url: 'https://a.example/x', title: '1' }] }] }] });
  assert.deepEqual(parsed.sources, [{ url: 'https://a.example/x', title: 'a.example' }]);
});

test('Claude: API keys and subscription tokens; models and effort come from Anthropic; pausing is opt-in', async () => {
  const { claude, claudeCredentialAllowed, CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE } = await import('../dist/index.js');
  assert.equal(claudeCredentialAllowed('sk-ant-api03-x'), true);
  assert.equal(claudeCredentialAllowed('sk-ant-oat01-x'), true);
  assert.equal(claudeCredentialAllowed('sk-ant-oat01-x', true), false);
  assert.deepEqual(claude().signIn.map(method => method.kind), ['api-key']);
  const setup = claude().signIn[0].kind === 'api-key' ? claude().signIn[0].setup ?? [] : [];
  assert.deepEqual(setup.map(step => new URL(step.url).host), ['claude.ai', 'platform.claude.com']);
  const calls = fakeFetch(() => new Response(JSON.stringify({ data: [
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', capabilities: { effort: { supported: true, low: { supported: true }, max: { supported: true } } } },
  ] })));
  assert.deepEqual(await claude().listModels('sk-ant-api03-x'), [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoningEfforts: [{ effort: 'low' }, { effort: 'max' }] }]);
  assert.equal(calls[0].url.startsWith('https://api.anthropic.com/v1/models'), true);
  assert.equal((calls[0].init?.headers as Record<string, string>)['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(calls[0].init?.redirect, 'error');
  await assert.rejects(() => claude({ subscriptionsPaused: true }).listModels('sk-ant-oat01-x'), (error: Error) => error.message === CLAUDE_SUBSCRIPTIONS_PAUSED_NOTE);
  assert.equal(calls.length, 1);
  await claude().listModels('sk-ant-oat01-x');
  const h = calls[1].init?.headers as Record<string, string>;
  assert.equal(h.Authorization, 'Bearer sk-ant-oat01-x');
  assert.equal(h['x-api-key'], undefined);
  assert.match(h['anthropic-beta'], /oauth-2025-04-20/);
});

test('Claude streams text, thinking and usage from the Messages API', async () => {
  const { claude } = await import('../dist/index.js');
  const calls = fakeFetch(() => sse([
    'event: message_start', 'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}',
    'data: {"type":"message_delta","usage":{"output_tokens":4}}',
  ]));
  const events = [];
  for await (const event of claude().stream('sk-ant-api03-x', { model: 'm', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], effort: 'low' })) events.push(event);
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Hi' }, { type: 'usage', inputTokens: 9, outputTokens: 4 }, { type: 'done' },
  ]);
  assert.equal(calls[0].init?.redirect, 'error');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.system, 'be brief');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(body.output_config, { effort: 'low' });
});

test('Claude subscription tokens stream with Bearer, the OAuth beta and the Claude Code system block', async () => {
  const { claude } = await import('../dist/index.js');
  const calls = fakeFetch(() => sse(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}']));
  for await (const _ of claude().stream('sk-ant-oat01-x', { model: 'm', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] })) { /* drain */ }
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-ant-oat01-x');
  assert.equal(headers['x-api-key'], undefined);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(body.system, [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: 'text', text: 'be brief' }]);
});

test('orderServices lists subscriptions first, then OpenRouter, Groq, Hugging Face, and a site order wins', () => {
  const ids = ['huggingface', 'openrouter', 'other', 'groq', 'grok', 'chatgpt', 'claude'] as const;
  const keyOf = (id: string) => (id === 'other' ? undefined : id as ServiceKey);
  assert.deepEqual(orderServices(ids, keyOf), ['claude', 'chatgpt', 'grok', 'openrouter', 'groq', 'huggingface', 'other']);
  assert.deepEqual(orderServices(ids, keyOf, ['openrouter', 'grok']), ['openrouter', 'grok', 'huggingface', 'other', 'groq', 'chatgpt', 'claude']);
  assert.equal(NOT_RECOMMENDED_REASON.claude, undefined);
});

test('claudeAcceptsTemperature is false for Claude 4.7+ and the 5-series, true for older Claude', () => {
  for (const id of ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307', 'claude-sonnet-4-20250514', 'claude-opus-4-1-20250805', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-6', 'Claude-Sonnet-4-6']) assert.equal(claudeAcceptsTemperature(id), true, id);
  for (const id of ['claude-opus-4-7', 'claude-sonnet-4-8', 'claude-opus-4-10', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-5-sonnet', 'claude-sonnet-6']) assert.equal(claudeAcceptsTemperature(id), false, id);
  for (const id of ['', 'claude', 'claude-sonnet', 'gpt-4', 'grok-4.7', 'my-claude-4-5']) assert.equal(claudeAcceptsTemperature(id), false, id);
});

test('model discovery failures carry the HTTP status and keep their message', async () => {
  fakeFetch(() => Response.json({ error: { message: 'Insufficient credits for sk-secret-key' } }, { status: 402 }));
  await assert.rejects(listModelsForEndpoint({ ...endpointFor('groq', 'sk-secret-key', {}) }), (e: ProviderRequestError) => e instanceof ProviderRequestError && e.status === 402 && e.message.includes('Insufficient credits') && !e.message.includes('sk-secret-key'));
  fakeFetch(() => Response.json({}, { status: 503 }));
  await assert.rejects(listModelsForEndpoint(endpointFor('groq', 'k', {})), (e: ProviderRequestError) => e.status === 503 && e.message === 'Could not load models.');
  await assert.rejects(listOpenRouterModels('k'), (e: ProviderRequestError) => e.status === 503 && e.message === 'Could not load OpenRouter models.');
  fakeFetch(() => Response.json({}, { status: 403 }));
  await assert.rejects(listOpenRouterModels('k'), (e: OpenRouterAuthenticationError) => e instanceof ProviderRequestError && e.name === 'OpenRouterAuthenticationError' && e.status === 403 && e.message === 'OpenRouter rejected this key. Reconnect your OpenRouter account.');
});

test('classifyProviderError sorts failures and never returns provider text', () => {
  const secret = 'sk-secret-key';
  const kind = (e: unknown) => classifyProviderError(e).kind;
  assert.equal(kind(new ProviderRequestError(secret, 401)), 'auth');
  assert.equal(kind(new ProviderRequestError(secret, 403)), 'auth');
  assert.equal(kind(new ProviderRequestError(secret, 402)), 'quota');
  assert.equal(kind(new ProviderRequestError(secret, 429)), 'quota');
  assert.equal(kind(new ProviderRequestError(secret, 500)), 'unavailable');
  assert.equal(kind(new OpenRouterAuthenticationError()), 'auth');
  assert.equal(kind(Object.assign(new Error(secret), { status: 401 })), 'auth');
  assert.equal(kind(new DOMException('x', 'AbortError')), 'aborted');
  assert.equal(kind(new DOMException('x', 'TimeoutError')), 'aborted');
  assert.equal(kind(new TypeError('fetch failed')), 'unavailable');
  assert.equal(kind('boom'), 'unavailable');
  assert.equal(kind(undefined), 'unavailable');
  for (const e of [new ProviderRequestError(secret, 401), new ProviderRequestError(secret, 429), new Error(secret)]) assert.ok(!classifyProviderError(e).message.includes(secret));
});
