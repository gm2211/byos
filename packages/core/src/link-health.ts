/** Telling a dead or poor link from a slow model, and falling back to an on-device model when the
 *  connection is really gone. Shared by TypeScript and ByosCore Swift; ported from Skim (SkimCore
 *  LinkHealth, OfflineAIFallback, src/lib/mirrorChat.ts). Vectors in conformance/link-health.json.
 *
 *  A non-streamed answer says nothing until it is done, so a slow answer and a dead link look the same
 *  from the request. A TCP handshake with the provider's host (or any cheap probe) tells them apart in
 *  one round trip. One bad probe is noise: a link is bad only after `LINK_STRIKES` in a row. */

/** Probe budget: a handshake that takes longer is as good as none. */
export const PROBE_TIMEOUT_MS = 2_500;
/** A handshake slower than this is a link too poor to carry an answer soon (EDGE-class). */
export const DEGRADED_RTT_MS = 800;
/** How often the link is checked again while an answer is pending. */
export const REPROBE_MS = 3_000;
/** How soon a bad probe is checked again, to confirm it. */
export const CONFIRM_REPROBE_MS = 1_000;
/** Bad probes in a row that make a bad link. */
export const LINK_STRIKES = 2;

export type HedgeBounds = { min: number; max: number; initial: number };
/** How long a healthy link may stay silent on a chat answer before an on-device model starts. */
export const CHAT_HEDGE_BOUNDS: HedgeBounds = { min: 5_000, max: 30_000, initial: 12_000 };
/** A summary is two long completions, so it gets more room than a chat answer. */
export const SUMMARY_HEDGE_BOUNDS: HedgeBounds = { min: 8_000, max: 45_000, initial: 20_000 };

export type LinkVerdict = 'healthy' | 'degraded' | 'down';

/** `rttMs` null means the probe failed or timed out. */
export function linkVerdict(rttMs: number | null, slowRadio = false): LinkVerdict {
  if (rttMs === null || !Number.isFinite(rttMs) || rttMs > PROBE_TIMEOUT_MS) return 'down';
  return rttMs > DEGRADED_RTT_MS || slowRadio ? 'degraded' : 'healthy';
}

/** Whether one probe counts against the link. On a steady path (Wi-Fi or wired, not a data-saving
 *  mode) a probe that completes is good enough however slow: only a failed one counts. */
export function isBadProbe(rttMs: number | null, options: { slowRadio?: boolean; steadyPath?: boolean } = {}): boolean {
  const verdict = linkVerdict(rttMs, options.slowRadio);
  return verdict === 'down' || (verdict === 'degraded' && !options.steadyPath);
}

/** How long a healthy link may stay silent: 1.25 times the 90th percentile of recent answers, within
 *  the bounds, so a model that always takes 20 s isn't raced every time; `initial` with fewer than 5. */
export function adaptiveHedgeMs(recentAnswerMs: number[], bounds: HedgeBounds = CHAT_HEDGE_BOUNDS): number {
  if (recentAnswerMs.length < 5) return bounds.initial;
  const sorted = [...recentAnswerMs].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]!;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, p90 * 1.25)));
}

/** Probes at once and then every `REPROBE_MS` until aborted; true once `LINK_STRIKES` probes in a row
 *  count against the link. A bad probe is checked again after `CONFIRM_REPROBE_MS`. */
export async function watchLink(
  probe: () => Promise<number | null>,
  options: { signal?: AbortSignal; slowRadio?: () => boolean; steadyPath?: () => boolean; wait?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let inARow = 0;
  while (!options.signal?.aborted) {
    const rtt = await probe().catch(() => null);
    if (options.signal?.aborted) return false;
    inARow = isBadProbe(rtt, { slowRadio: options.slowRadio?.(), steadyPath: options.steadyPath?.() }) ? inARow + 1 : 0;
    if (inARow >= LINK_STRIKES) return true;
    await wait(inARow > 0 ? CONFIRM_REPROBE_MS : REPROBE_MS);
  }
  return false;
}

/** A host on the device's own network (loopback, .local, private IPv4), which needs no internet. */
export function isLocalNetworkHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.startsWith('127.') || h === '::1') return true;
  const parts = h.split('.');
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number) as [number, number];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** A request that failed on a healthy link: the provider's failure, not the connection's. Its message
 *  is safe to show, and it should not send the app offline. */
export class ProviderFailure extends Error {
  constructor(message: string) { super(message); this.name = 'ProviderFailure'; }
}

/** The sentence for a timeout or dropped request on a link that still answers a probe. */
export function providerFailureMessage(providerName: string, detail: { timedOut: boolean; reason?: string }): string {
  if (detail.timedOut) return `${providerName} took too long to answer. Your connection is fine; try again.`;
  return `${providerName} didn't answer${detail.reason ? ` (${detail.reason})` : ''}. Your connection is fine; try again.`;
}

/** Which model a request is for: `auto` falls back only when offline; `online` never falls back (the
 *  caller does); `local` always uses the on-device stand-in. */
export type FallbackRoute = 'auto' | 'online' | 'local';

export type OfflineFallbackOptions<S> = {
  /** Whether `settings` talks to a server off the device's own network. */
  needsConnection: (settings: S) => boolean;
  /** `settings` pointed at an on-device model that can answer now, or undefined when none is ready. */
  reroute: (settings: S) => S | undefined;
  /** Whether the provider's link still answers a probe. */
  linkHealthy: (settings: S) => Promise<boolean>;
  /** A failure that means the request never reached the provider. */
  isConnectivityError: (error: unknown) => boolean;
  /** A failure the system itself attributes to having no connection; nothing to probe. */
  isNoConnectionError?: (error: unknown) => boolean;
  /** Whether the device already knows it is offline. */
  offline?: boolean;
  route?: FallbackRoute;
  /** Called when the connection turns out to be gone, so the app can show it. */
  onUnreachable?: () => void;
  /** Builds the error for a failure on a healthy link. */
  providerFailure?: (error: unknown, settings: S) => Error;
};

/**
 * Runs `request` on the provider in effect, and once more on the on-device model when a cloud request
 * fails for want of a connection the system had not noticed was gone. A timeout or dropped request
 * counts as a lost connection only when the provider's link no longer answers a probe; on a healthy
 * link it is thrown as the provider's failure, so a slow provider never looks like being offline.
 */
export async function runWithOfflineFallback<S, T>(settings: S, options: OfflineFallbackOptions<S>, request: (settings: S) => Promise<T>): Promise<T> {
  const route = options.route ?? 'auto';
  let effective = settings;
  if (route !== 'online' && (options.offline || route === 'local') && options.needsConnection(settings)) {
    effective = options.reroute(settings) ?? settings;
  }
  try {
    return await request(effective);
  } catch (error) {
    if (route === 'local' || !options.needsConnection(effective) || !options.isConnectivityError(error)) throw error;
    if (!options.isNoConnectionError?.(error) && await options.linkHealthy(effective)) {
      throw options.providerFailure?.(error, effective) ?? new ProviderFailure(providerFailureMessage('The provider', { timedOut: /timed? ?out/i.test(String((error as Error)?.message ?? error)), reason: (error as Error)?.message }));
    }
    if (route === 'online') { options.onUnreachable?.(); throw error; }
    const local = options.reroute(effective);
    if (!local) throw error;
    options.onUnreachable?.();
    return request(local);
  }
}
