import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_ACCOUNT_CATALOG_URL, CODEX_CLIENT_VERSION } from '@byos/core';
import { createCodexTlsFetch, type BrowserTlsEngine } from '../dist/transport.js';

const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
const marker = 'synthetic-provider-secret-for-boundary-test';
let lastSocket: FakeWebSocket | undefined;
let engineInstance: FakeTls | undefined;
let wireWrites: unknown[] = [];
let plaintextWrites: Uint8Array[] = [];

class FakeTls implements BrowserTlsEngine {
  authenticated = false;
  wasFreed = false;
  pendingPlaintext = new Uint8Array();
  free() { this.wasFreed = true; }
  ready() { return this.authenticated; }
  closed() { return false; }
  receive(bytes: Uint8Array) {
    if (!this.authenticated) {
      if (bytes[0] !== 42) throw new Error('certificate rejected');
      this.authenticated = true;
      return 1;
    }
    this.pendingPlaintext = bytes.slice();
    return bytes.length;
  }
  outgoing() { return new Uint8Array([1, 2, 3]); }
  plaintext() { const bytes = this.pendingPlaintext; this.pendingPlaintext = new Uint8Array(); return bytes; }
  write(bytes: Uint8Array) { plaintextWrites.push(bytes.slice()); return bytes.length; }
}

class FakeWebSocket {
  bufferedAmount = 0;
  binaryType = '';
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string | URL) { lastSocket = this; queueMicrotask(() => this.onopen?.()); }
  send(value: unknown) {
    wireWrites.push(value);
    if (typeof value === 'string') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ ready: true, version: 1 }) }));
  }
  close() { this.closed = true; }
}

function prepare(t: test.TestContext, response: Response = Response.json({ ticket: 'synthetic_ticket_123456', expiresAt: Date.now() + 30_000 })) {
  wireWrites = [];
  plaintextWrites = [];
  lastSocket = undefined;
  engineInstance = undefined;
  const previousSocket = globalThis.WebSocket;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousFetch = globalThis.fetch;
  const records: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeWebSocket });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://app.example/', protocol: 'https:' } });
  let requests = 0;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => { requests++; records.push({ input, init }); return response; } });
  t.after(() => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: previousSocket });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: previousFetch });
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete (globalThis as { location?: Location }).location;
  });
  const options = {
    loadEngine: async () => ({ BrowserTls: class extends FakeTls { constructor(_host: string) { super(); engineInstance = this; } } }),
    relayBasePath: '/api/relay',
    clientLabel: 'Synthetic Test',
  };
  return { options, records, get requests() { return requests; }, requestCount: () => requests };
}

async function opened(): Promise<FakeWebSocket> {
  for (let i = 0; i < 50 && !lastSocket; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(lastSocket, 'websocket opened');
  return lastSocket;
}

async function waitForWrites(): Promise<void> {
  for (let i = 0; i < 50 && plaintextWrites.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(plaintextWrites.length > 0, 'request written after the TLS handshake');
}

test('relay paths and session configuration fail before fetch or engine loading', () => {
  let loads = 0;
  const base = { loadEngine: async () => { loads++; return { BrowserTls: FakeTls }; }, clientLabel: 'test' };
  for (const relayBasePath of [
    'https://evil.example/relay', '//evil.example/relay', '/api/../relay', '/api/%2e%2e/relay',
    '/api//relay', '/api/relay?next=evil', '/api/relay#fragment', '/api\\relay', '/',
  ]) assert.throws(() => createCodexTlsFetch({ ...base, relayBasePath }), /relayBasePath/);
  assert.throws(() => createCodexTlsFetch({ ...base, relayBasePath: '/api/relay', getSession: () => null }), /both getSession and sessionHeader/);
  assert.throws(() => createCodexTlsFetch({ ...base, relayBasePath: '/api/relay', sessionHeader: 'X-Session' }), /both getSession and sessionHeader/);
  assert.throws(() => createCodexTlsFetch({ ...base, relayBasePath: '/api/relay', getSession: () => null, sessionHeader: 'bad header' }), /valid HTTP header/);
  assert.equal(loads, 0);
});

test('cookie session ticket request stays same-origin and does not forward provider credentials', async t => {
  const state = prepare(t);
  const transport = createCodexTlsFetch(state.options);
  const controller = new AbortController();
  const pending = transport(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${marker}` }, body: 'private prompt', signal: controller.signal });
  const socket = await opened();
  assert.equal(state.requestCount(), 1);
  const ticketCall = state.records[0];
  assert.equal(ticketCall.input, '/api/relay/ticket');
  assert.equal(ticketCall.init?.credentials, 'same-origin');
  const ticketHeaders = new Headers(ticketCall.init?.headers);
  assert.equal(ticketHeaders.has('Authorization'), false);
  assert.deepEqual(JSON.parse(String(ticketCall.init?.body)), { destination: 'responses' });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(socket.closed, true);
});

test('header session mode remains available and carries only the site session to the ticket route', async t => {
  const state = prepare(t);
  const transport = createCodexTlsFetch({
    ...state.options,
    getSession: () => ({ session: 'synthetic-site-session', expiresAt: Date.now() + 60_000 }),
    sessionHeader: 'X-App-Session',
  });
  const controller = new AbortController();
  const pending = transport(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${marker}` }, body: 'private prompt', signal: controller.signal });
  await opened();
  const ticketCall = state.records[0];
  assert.equal(ticketCall.input, '/api/relay/ticket');
  assert.equal(ticketCall.init?.credentials, 'omit');
  assert.equal(new Headers(ticketCall.init?.headers).get('X-App-Session'), 'synthetic-site-session');
  assert.equal(new Headers(ticketCall.init?.headers).has('Authorization'), false);
  assert.equal(JSON.stringify(ticketCall.init).includes(marker), false);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(state.requestCount(), 1);
});

test('request plaintext follows the verified TLS signal; abort closes the stream and frees TLS state', async t => {
  const state = prepare(t);
  const transport = createCodexTlsFetch(state.options);
  const controller = new AbortController();
  const pending = transport(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${marker}` }, body: 'private prompt', signal: controller.signal });
  const socket = await opened();
  assert.equal(plaintextWrites.length, 0);
  socket.onmessage?.({ data: new Uint8Array([42]).buffer });
  await waitForWrites();
  const clear = plaintextWrites.map(bytes => new TextDecoder().decode(bytes)).join('');
  assert.ok(clear.includes(marker));
  assert.ok(!wireWrites.some(value => typeof value === 'string' && value.includes(marker)));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(socket.closed, true);
  assert.equal(engineInstance?.wasFreed, true);
});

test('authenticated HTTP response streams across split relay frames', async t => {
  const state = prepare(t);
  const transport = createCodexTlsFetch(state.options);
  const pending = transport(endpoint, { method: 'POST', body: 'private prompt' });
  const socket = await opened();
  socket.onmessage?.({ data: new Uint8Array([42]).buffer });
  await waitForWrites();
  const responseBytes = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nready');
  for (let offset = 0; offset < responseBytes.length; offset += 7) {
    socket.onmessage?.({ data: responseBytes.slice(offset, offset + 7).buffer });
  }
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ready');
  assert.equal(socket.closed, true);
  assert.equal(engineInstance?.wasFreed, true);
});

test('relay 503 uses generic configurable copy and never includes its response body', async t => {
  const marker = 'synthetic-private-relay-detail';
  const state = prepare(t, new Response(marker, { status: 503 }));
  let loads = 0;
  const transport = createCodexTlsFetch({ ...state.options, loadEngine: async () => { loads++; return { BrowserTls: FakeTls }; } });
  await assert.rejects(transport(endpoint, { method: 'POST', body: '{}' }), error => {
    assert.equal(String(error), 'CodexTransportError: The encrypted Codex browser connection is unavailable right now.');
    assert.ok(!String(error).includes(marker));
    return true;
  });
  assert.equal(loads, 1, 'engine loading may run in parallel with ticket creation');
  assert.equal(state.requestCount(), 1);

  const customizedState = prepare(t, new Response(marker, { status: 503 }));
  const customized = createCodexTlsFetch({ ...customizedState.options, messages: { relayUnavailable: 'Try again after reconnecting.' } });
  await assert.rejects(customized(endpoint, { method: 'POST', body: '{}' }), /Try again after reconnecting/);
  assert.equal(customizedState.requestCount(), 1);
});

test('account catalog query and TLS compatibility headers share the reviewed version', async t => {
  const state = prepare(t);
  const transport = createCodexTlsFetch(state.options);
  const pending = transport(CODEX_ACCOUNT_CATALOG_URL, { headers: { Authorization: `Bearer ${marker}` } });
  const socket = await opened();
  socket.onmessage?.({ data: new Uint8Array([42]).buffer });
  await waitForWrites();
  const clear = plaintextWrites.map(bytes => new TextDecoder().decode(bytes)).join('');
  assert.ok(clear.startsWith(`GET /backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION} HTTP/1.1\r\n`));
  assert.match(clear, new RegExp(`user-agent: codex_cli_rs/${CODEX_CLIENT_VERSION.replaceAll('.', '\\.')}`, 'i'));
  assert.ok(clear.toLowerCase().includes(`version: ${CODEX_CLIENT_VERSION}\r\n`));
  assert.ok(!JSON.stringify(state.records).includes(marker));
  assert.ok(!wireWrites.some(value => typeof value === 'string' && value.includes(marker)));
  const body = JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', supported_in_api: true }] });
  socket.onmessage?.({ data: new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n${body}`).buffer });
  const response = await pending;
  assert.deepEqual(await response.json(), JSON.parse(body));
});
