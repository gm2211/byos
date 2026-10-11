import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { WebSocket } from 'ws';
import { createCodexRelay } from '../dist/codex-relay.js';

const origin = 'https://app.example';

function ticketHandler(relay: ReturnType<typeof createCodexRelay>) {
  const stack = (relay.router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: (request: unknown, response: unknown) => Promise<void> }> } }> }).stack;
  const layer = stack.find(item => item.route?.path === '/api/relay/ticket');
  assert.ok(layer?.route?.stack[0]);
  return layer.route.stack[0].handle;
}

async function requestTicket(
  handler: ReturnType<typeof ticketHandler>,
  headers: Record<string, string> = {},
  body: unknown = { destination: 'responses' },
) {
  const request = {
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
    body,
    get(name: string) { return this.headers[name.toLowerCase()]; },
  };
  const result = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    set(name: string, value: string) { this.headers[name] = value; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  await handler(request, result);
  return result;
}

function relayOptions(overrides: Partial<Parameters<typeof createCodexRelay>[0]> = {}) {
  return {
    basePath: '/api/relay',
    resolveSession: async (session: string) => session === 'valid' ? { ownerKey: 'account-a' } : undefined,
    allowedOrigins: () => new Set([origin]),
    enabled: () => true,
    ...overrides,
  };
}

test('cookie session reader grants tickets and rejects missing, invalid, or cross-origin requests', async () => {
  let reads = 0;
  const relay = createCodexRelay(relayOptions({
    readSession: request => {
      reads++;
      const cookie = request.headers.cookie ?? '';
      return /(?:^|;\s*)app_session=([^;]+)/.exec(cookie)?.[1];
    },
  }));
  const handle = ticketHandler(relay);
  const ticketRequest = (headers: Record<string, string> = {}) => requestTicket(handle, { Origin: origin, ...headers });

  const success = await ticketRequest({ Cookie: 'app_session=valid' });
  assert.equal(success.statusCode, 200);
  const body = success.body as { ticket: string; expiresAt: number };
  assert.match(body.ticket, /^[A-Za-z0-9_-]{32,}$/);
  assert.ok(body.expiresAt > Date.now());
  assert.equal((await ticketRequest()).statusCode, 401);
  assert.equal((await ticketRequest({ Cookie: 'app_session=expired' })).statusCode, 401);
  assert.equal((await ticketRequest({ Origin: 'https://attacker.example', Cookie: 'app_session=valid' })).statusCode, 403);
  assert.equal(reads, 3, 'origin rejection happens before cookie parsing');
});

test('a session reader exception returns a generic 503 without leaking its error', async () => {
  const marker = 'synthetic-session-parser-detail';
  const relay = createCodexRelay(relayOptions({ readSession: () => { throw new Error(marker); } }));
  const response = await requestTicket(ticketHandler(relay), { Origin: origin }, { destination: 'auth' });
  assert.equal(response.statusCode, 503);
  assert.ok(!JSON.stringify(response.body).includes(marker));
});

test('header session mode remains supported and session modes cannot be ambiguous', async () => {
  const relay = createCodexRelay(relayOptions({
    sessionHeader: 'X-App-Session',
    resolveSession: async session => session === 'valid' ? { ownerKey: 'account-header' } : undefined,
  }));
  const response = await requestTicket(ticketHandler(relay), { Origin: origin, 'X-App-Session': 'valid' });
  assert.equal(response.statusCode, 200);
  assert.throws(() => createCodexRelay(relayOptions()), /exactly one of sessionHeader or readSession/);
  assert.throws(() => createCodexRelay(relayOptions({ sessionHeader: 'X-App-Session', readSession: () => 'valid' })), /exactly one/);
});

test('relay basePath rejects external URLs, traversal, separators, and URL suffixes at construction', () => {
  for (const basePath of [
    'https://evil.example/relay', '//evil.example/relay', '/api/../relay', '/api/%2e%2e/relay',
    '/api//relay', '/api/relay?next=evil', '/api/relay#fragment', '/api\\relay', '/',
  ]) assert.throws(() => createCodexRelay(relayOptions({ basePath, sessionHeader: 'X-App-Session' })), /basePath/);
});

test('default relay serves only auth and responses; xai-auth is rejected for tickets and upgrades', async () => {
  const relay = createCodexRelay(relayOptions({ sessionHeader: 'X-App-Session' }));
  const headers = { Origin: origin, 'X-App-Session': 'valid' };
  const rejected = await requestTicket(ticketHandler(relay), headers, { destination: 'xai-auth' });
  assert.equal(rejected.statusCode, 400);
  assert.equal((rejected.body as { error: string }).error, 'A valid Codex destination is required.');
  assert.equal((await requestTicket(ticketHandler(relay), headers, { destination: 'auth' })).statusCode, 200);
  const { status } = await upgradeStatus(relay, '/api/relay/xai-auth');
  assert.equal(status, 403);
});

type Relay = ReturnType<typeof createCodexRelay>;

async function withServer<T>(relay: Relay, run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer();
  relay.handleUpgrade(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run((server.address() as AddressInfo).port); }
  finally { relay.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function upgradeStatus(relay: Relay, path: string): Promise<{ status?: number }> {
  return withServer(relay, port => new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode }); });
    ws.on('open', () => { ws.close(); resolve({}); });
    ws.on('error', () => undefined);
  }));
}

test('relay with the xai-auth destination issues a ticket and dials only auth.x.ai', async () => {
  const hosts: string[] = [];
  const relay = createCodexRelay(relayOptions({
    sessionHeader: 'X-App-Session',
    destinations: ['auth', 'xai-auth'],
    lookupAddresses: async host => { hosts.push(host); return [{ address: '8.8.8.8', family: 4 }]; },
    connect: async host => { hosts.push(`connect:${host}`); throw new Error('synthetic_unreachable'); },
  }));
  const headers = { Origin: origin, 'X-App-Session': 'valid' };
  const granted = await requestTicket(ticketHandler(relay), headers, { destination: 'xai-auth' });
  assert.equal(granted.statusCode, 200);
  // The relay still refuses the unlisted 'responses' destination.
  assert.equal((await requestTicket(ticketHandler(relay), headers, { destination: 'responses' })).statusCode, 400);
  const { ticket } = granted.body as { ticket: string };
  await withServer(relay, port => new Promise<void>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/xai-auth`, { origin });
    ws.on('open', () => ws.send(JSON.stringify({ ticket, version: 1 })));
    ws.on('close', () => resolve());
    ws.on('error', () => undefined);
  }));
  assert.deepEqual(hosts, ['auth.x.ai', 'connect:auth.x.ai']);
});

test('a ticket issued for auth cannot open the xai-auth tunnel', async () => {
  const hosts: string[] = [];
  const relay = createCodexRelay(relayOptions({
    sessionHeader: 'X-App-Session',
    destinations: ['auth', 'xai-auth'],
    lookupAddresses: async host => { hosts.push(host); return [{ address: '8.8.8.8', family: 4 }]; },
    connect: async () => { throw new Error('synthetic_unreachable'); },
  }));
  const granted = await requestTicket(ticketHandler(relay), { Origin: origin, 'X-App-Session': 'valid' }, { destination: 'auth' });
  const { ticket } = granted.body as { ticket: string };
  await withServer(relay, port => new Promise<void>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/xai-auth`, { origin });
    ws.on('open', () => ws.send(JSON.stringify({ ticket, version: 1 })));
    ws.on('close', () => resolve());
    ws.on('error', () => undefined);
  }));
  assert.deepEqual(hosts, [], 'no DNS lookup or dial for a mismatched ticket');
});

test('invalid destinations options throw at construction', () => {
  for (const destinations of [[], ['auth', 'auth'], ['auth', 'evil'], ['auth.x.ai']] as unknown as Array<Array<'auth'>>) {
    assert.throws(() => createCodexRelay(relayOptions({ sessionHeader: 'X-App-Session', destinations })), /destinations/);
  }
  assert.doesNotThrow(() => createCodexRelay(relayOptions({ sessionHeader: 'X-App-Session', destinations: ['xai-auth'] })));
});
