/**
 * `chatgpt()`: the default ByosProvider for a ChatGPT subscription in the browser. It offers the
 * Codex device-code sign-in first (no paste: the person types a short code on chatgpt.com) and the
 * official Sign in with ChatGPT second, as the fallback when the site has no ciphertext relay or the
 * person prefers OpenAI's own app registration. Each stored credential remembers which path made it,
 * so listModels/stream go to the matching adapter. Giulio made the code sign-in the default on
 * 2026-11-21 after it worked on tracked.cc; OpenAI could still turn off the Codex client's sign-in
 * for third parties, which is why the official path stays one click away.
 */
import type { ByosProvider, SignInMethod } from '@byos/core';
import { chatgptPlan, decodeChatGptPlanCredential, type ChatGptPlanProviderOptions } from './plan.js';
import { codex, type CodexProviderOptions } from './provider.js';

export type ChatGptProviderOptions = {
  /** The device-code (Codex) path: browser-owned TLS fetch through the site's ciphertext relay. */
  code: CodexProviderOptions;
  /** The official Sign in with ChatGPT path (pkce, paste-code completion). */
  official: ChatGptPlanProviderOptions;
};

/** Which adapter made this stored credential: `official` for chatgptPlan records, else `code`. */
export function chatgptCredentialPath(token: string | null | undefined): 'official' | 'code' {
  return decodeChatGptPlanCredential(token) ? 'official' : 'code';
}

export function chatgpt(options: ChatGptProviderOptions): ByosProvider {
  const byCode = codex(options.code);
  const official = chatgptPlan(options.official);
  const forToken = (token: string) => (chatgptCredentialPath(token) === 'official' ? official : byCode);
  return {
    id: 'chatgpt',
    displayName: 'ChatGPT',
    // Code first: it is the default. Hosts that cannot run the relay still get the official path.
    signIn: [...byCode.signIn, ...official.signIn] satisfies SignInMethod[],
    webSearch: true,
    availability: () => {
      const code = byCode.availability();
      if (code.available) return code;
      const fallback = official.availability();
      return fallback.available ? fallback : code;
    },
    listModels: (token, signal) => forToken(token).listModels(token, signal),
    stream: (token, request) => forToken(token).stream(token, request),
  };
}

/** True when the code sign-in path can run on this site now (relay gate on). */
export function chatgptCodeSignInAvailable(options: Pick<ChatGptProviderOptions, 'code'>): boolean {
  return !options.code.unavailableReason?.();
}
