import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ChatGptError } from '@byos/chatgpt-local';

/** No provider credentials enter this HTTP bridge. The client stays in the local process. */
export async function createExampleServer(client) {
  const csrf = randomBytes(32).toString('hex');
  const nonce = randomBytes(24).toString('hex');
  const page = (await readFile(new URL('./index.html', import.meta.url), 'utf8'))
    .replaceAll('__NONCE__', nonce).replaceAll('__CSRF__', csrf);
  const active = new Set();
  let origin;
  let host;
  const server = createServer((request, response) => {
    const controller = new AbortController();
    active.add(controller);
    response.once('close', () => { active.delete(controller); if (!response.writableEnded) controller.abort(); });
    const send = (status, value, html = false) => {
      response.writeHead(status, {
        'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json',
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      });
      response.end(html ? value : JSON.stringify(value));
    };
    void (async () => {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
          || request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin)) {
        send(403, { error: 'Open the local example URL directly.' }); return;
      }
      const path = new URL(request.url, origin).pathname;
      if (request.method === 'GET' && path === '/') { send(200, page, true); return; }
      if (request.method === 'GET' && path === '/api/status') {
        send(200, { session: await client.status(), accounts: await client.accounts() }); return;
      }
      if (request.method === 'GET' && path === '/api/models') { send(200, await client.listModels(controller.signal)); return; }
      if (request.method !== 'POST') { send(404, { error: 'Not found.' }); return; }
      if (request.headers.origin !== origin || request.headers['x-byos-csrf'] !== csrf) {
        send(403, { error: 'Reload the example before continuing.' }); return;
      }
      if (!request.headers['content-type']?.startsWith('application/json')) { send(415, { error: 'JSON required.' }); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 32_768) { send(413, { error: 'Request too large.' }); return; }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { error: 'Invalid JSON.' }); return; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) { send(400, { error: 'Invalid request.' }); return; }
      if (path === '/api/connect') {
        send(200, await client.signIn({ signal: controller.signal, ...(typeof input.accountId === 'string' ? { accountId: input.accountId } : {}), ...(input.enablePlan === true ? { enablePlan: true } : {}) })); return;
      }
      if (path === '/api/select' && typeof input.id === 'string') { await client.selectAccount(input.id); send(200, await client.status()); return; }
      if (path === '/api/disconnect') { send(200, await client.disconnect()); return; }
      if (path === '/api/generate' && typeof input.model === 'string' && typeof input.input === 'string' && input.input.trim()) {
        send(200, await client.generate({ model: input.model, input: input.input, signal: controller.signal })); return;
      }
      send(400, { error: 'Invalid request.' });
    })().catch(error => {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof ChatGptError) {
        // Rebuild fixed copy from the library code; never forward provider/error message text.
        const safe = new ChatGptError(error.code);
        send(error.code === 'quota' ? 429 : 400, { code: safe.code, error: safe.message });
      } else {
        send(400, { error: 'Request did not complete. Check your connection or ChatGPT usage, then try again.' });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  host = `127.0.0.1:${server.address().port}`;
  origin = `http://${host}`;
  return { origin, server, close: async () => {
    for (const controller of active) controller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createChatGptClient } = await import('@byos/chatgpt-local');
  const client = createChatGptClient({
    appName: 'BYOS Example', namespace: 'byos-example',
    openBrowser: async url => {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://auth.openai.com' || parsed.searchParams.has('id_token_hint')) throw Error('Invalid authorization URL.');
      await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/open', [url], { stdio: 'ignore' });
        child.on('error', () => reject(Error('Could not open browser.')));
        child.on('exit', code => code === 0 ? resolve() : reject(Error('Could not open browser.')));
      });
    },
  });
  const example = await createExampleServer(client);
  console.log(`BYOS ChatGPT example: ${example.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void example.close().then(() => process.exit(0)));
}
