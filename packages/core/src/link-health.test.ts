import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// Built output: the sources use NodeNext `.js` imports.
import {
  adaptiveHedgeMs, CHAT_HEDGE_BOUNDS, CONFIRM_REPROBE_MS, DEGRADED_RTT_MS, isBadProbe, isLocalNetworkHost, LINK_STRIKES,
  linkVerdict, PROBE_TIMEOUT_MS, ProviderFailure, providerFailureMessage, REPROBE_MS, runWithOfflineFallback,
  SUMMARY_HEDGE_BOUNDS, watchLink, type FallbackRoute,
} from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('../conformance/link-health.json', import.meta.url), 'utf8'));

test('policy matches the vectors', () => {
  const p = vectors.policy;
  assert.deepEqual([PROBE_TIMEOUT_MS, DEGRADED_RTT_MS, REPROBE_MS, CONFIRM_REPROBE_MS, LINK_STRIKES], [p.probeTimeoutMs, p.degradedRttMs, p.reprobeMs, p.confirmReprobeMs, p.strikes]);
  assert.deepEqual(CHAT_HEDGE_BOUNDS, p.chatHedge);
  assert.deepEqual(SUMMARY_HEDGE_BOUNDS, p.summaryHedge);
});

test('verdicts and bad probes', () => {
  for (const c of vectors.verdicts) assert.equal(linkVerdict(c.rttMs, c.slowRadio), c.expect, JSON.stringify(c));
  for (const c of vectors.badProbes) assert.equal(isBadProbe(c.rttMs, c), c.expect, JSON.stringify(c));
});

test('hedge deadlines', () => {
  for (const c of vectors.hedges) assert.equal(adaptiveHedgeMs(c.recentMs, c.bounds === 'summary' ? SUMMARY_HEDGE_BOUNDS : CHAT_HEDGE_BOUNDS), c.expect, c.name);
});

test('link watches', async () => {
  for (const c of vectors.watches as { name: string; probesMs: (number | null)[]; steadyPath: boolean; expect: boolean; probes: number; waitsMs: number[] }[]) {
    const controller = new AbortController();
    let probes = 0;
    const waits: number[] = [];
    const result = await watchLink(async () => c.probesMs[probes++] ?? null, {
      signal: controller.signal,
      steadyPath: () => c.steadyPath,
      wait: async ms => { waits.push(ms); if (probes >= c.probesMs.length) controller.abort(); },
    });
    assert.equal(result, c.expect, c.name);
    assert.equal(probes, c.probes, c.name);
    assert.deepEqual(waits, c.waitsMs, c.name);
  }
});

test('local network hosts', () => {
  for (const c of vectors.localHosts) assert.equal(isLocalNetworkHost(c.host), c.expect, c.host);
});

test('provider failure sentences', () => {
  for (const c of vectors.providerFailures) assert.equal(providerFailureMessage(c.provider, { timedOut: c.timedOut, reason: c.reason ?? undefined }), c.expect);
});

test('offline fallback follows the vectors', async () => {
  type Case = { name: string; route: FallbackRoute; offline: boolean; needsConnection: boolean; canReroute: boolean; fails: string[]; linkHealthy: boolean; expect: { ranOn: string[]; result?: string; error?: string; unreachable: boolean } };
  class Failure extends Error { kind: string; constructor(kind: string) { super(kind); this.kind = kind; } }
  for (const c of vectors.fallbacks as Case[]) {
    const ranOn: string[] = [];
    let unreachable = false;
    const run = runWithOfflineFallback<'cloud' | 'device', string>('cloud', {
      route: c.route,
      offline: c.offline,
      needsConnection: s => s === 'cloud' && c.needsConnection,
      reroute: () => (c.canReroute ? 'device' : undefined),
      linkHealthy: async () => c.linkHealthy,
      isConnectivityError: e => e instanceof Failure && (e.kind === 'connectivity' || e.kind === 'no-connection'),
      isNoConnectionError: e => e instanceof Failure && e.kind === 'no-connection',
      onUnreachable: () => { unreachable = true; },
    }, async s => {
      ranOn.push(s);
      const failure = c.fails.find(f => f.startsWith(`${s}:`));
      if (failure) throw new Failure(failure.split(':')[1]!);
      return s;
    });
    if (c.expect.result) assert.equal(await run, c.expect.result, c.name);
    else await assert.rejects(run, (e: unknown) => (c.expect.error === 'provider' ? e instanceof ProviderFailure : e instanceof Failure), c.name);
    assert.deepEqual(ranOn, c.expect.ranOn, c.name);
    assert.equal(unreachable, c.expect.unreachable, c.name);
  }
});
