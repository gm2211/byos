/** xAI (SuperGrok) device-code sign-in (RFC 8628) for Node, on the shared builders in @byos/core. */
import {
  classifyXaiPollError,
  parseXaiDeviceStart,
  parseXaiTokenResponse,
  XAI_FORM_HEADERS,
  XAI_SLOW_DOWN_SECONDS,
  xaiFormBody,
  xaiTokenUrl,
  type XaiTokenRequest,
  type XaiTokens,
} from '@byos/core';
import { GrokError, checkSignal } from './errors.js';

const REQUEST_TIMEOUT_MS = 20_000;

export type DeviceCodeInfo = { verificationUrl: string; userCode: string };
export type GrokFetch = typeof fetch;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new GrokError('canceled')); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});

/** One form POST to auth.x.ai; the body is parsed as JSON when possible, `{}` otherwise. Never redirects. */
export async function postForm(fetcher: GrokFetch, request: XaiTokenRequest, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: unknown }> {
  checkSignal(signal);
  let response: Response;
  try {
    response = await fetcher(xaiTokenUrl(request), {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { ...XAI_FORM_HEADERS },
      body: xaiFormBody(request),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch { checkSignal(signal); throw new GrokError('unavailable'); }
  const body: unknown = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

/** Starts the flow, hands the verification URL and user code to `onCode`, polls until approved. */
export async function deviceSignIn(options: {
  fetch: GrokFetch; onCode: (info: DeviceCodeInfo) => void | Promise<void>; signal?: AbortSignal; now: () => number; sleep: Sleep;
}): Promise<XaiTokens> {
  const { fetch: fetcher, signal, now, sleep } = options;
  const start = await postForm(fetcher, { kind: 'device_start' }, signal);
  const device = start.ok ? parseXaiDeviceStart(start.body, now()) : undefined;
  if (!device) throw new GrokError('unavailable', start.status);
  await options.onCode({ verificationUrl: device.verificationUriComplete ?? device.verificationUri, userCode: device.userCode });
  let wait = device.intervalSeconds * 1000;
  while (now() < device.expiresAt) {
    await sleep(wait, signal);
    checkSignal(signal);
    const poll = await postForm(fetcher, { kind: 'device_code', deviceCode: device.deviceCode }, signal);
    if (poll.ok) {
      const tokens = parseXaiTokenResponse(poll.body, { now: now() });
      if (!tokens) throw new GrokError('auth-failed', poll.status);
      return tokens;
    }
    switch (classifyXaiPollError(poll.status, poll.body)) {
      case 'pending': continue;
      case 'slow_down': wait += XAI_SLOW_DOWN_SECONDS * 1000; continue;
      case 'declined': throw new GrokError('declined', poll.status);
      case 'expired': throw new GrokError('expired', poll.status);
      default: throw new GrokError('auth-failed', poll.status);
    }
  }
  throw new GrokError('expired');
}
