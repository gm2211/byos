import type { ByosProvider, SignInMethod } from './provider.js';

/**
 * Which kinds of credential an application lets people connect.
 *
 * - `subscription-and-api-key`: plan sign-ins and pay-as-you-go API keys (the default).
 * - `subscription`: plan sign-ins only (Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok...). No API key
 *   field renders and a stored key is never used.
 * - `api-key`: API keys only.
 *
 * The application picks the mode; the kit applies it to provider lists, sign-in methods, the React
 * connect panel and the Swift `ByosCore` package alike. Credential-free providers (on-device models)
 * are unaffected. Vectors: conformance/credential-mode.json.
 */
export type CredentialMode = 'subscription-and-api-key' | 'subscription' | 'api-key';

/** What a sign-in method connects: an account plan, or a pay-as-you-go API key. */
export type CredentialKind = 'subscription' | 'api-key';

export const CREDENTIAL_MODES: readonly CredentialMode[] = ['subscription-and-api-key', 'subscription', 'api-key'];

export const DEFAULT_CREDENTIAL_MODE: CredentialMode = 'subscription-and-api-key';

export function isCredentialMode(value: unknown): value is CredentialMode {
  return typeof value === 'string' && (CREDENTIAL_MODES as readonly string[]).includes(value);
}

/** `value` when it names a mode, else `fallback`. For modes read from settings or configuration. */
export function parseCredentialMode(value: unknown, fallback: CredentialMode = DEFAULT_CREDENTIAL_MODE): CredentialMode {
  return isCredentialMode(value) ? value : fallback;
}

/**
 * `api-key` for a pasted pay-as-you-go key. Every other method (device code, PKCE, a pasted
 * subscription token such as `claude setup-token`) signs in to an account, so it is `subscription`.
 */
export function credentialKind(method: Pick<SignInMethod, 'kind'>): CredentialKind {
  return method.kind === 'api-key' ? 'api-key' : 'subscription';
}

export function allowsCredentialKind(mode: CredentialMode, kind: CredentialKind): boolean {
  return mode === 'subscription-and-api-key' || mode === kind;
}

export function allowsSignInMethod(mode: CredentialMode, method: Pick<SignInMethod, 'kind'>): boolean {
  return allowsCredentialKind(mode, credentialKind(method));
}

/** The methods `mode` allows, in their declared order. */
export function signInMethodsFor<M extends Pick<SignInMethod, 'kind'>>(methods: readonly M[], mode: CredentialMode): M[] {
  return methods.filter(method => allowsSignInMethod(mode, method));
}

/**
 * The providers `mode` offers, each with only its allowed sign-in methods. A provider whose every
 * method is filtered out is dropped; a provider that declares none (credential-free, such as an
 * on-device model) is kept. Returns copies; the inputs are not changed.
 */
export function providersForCredentialMode<P extends Pick<ByosProvider, 'signIn'>>(providers: readonly P[], mode: CredentialMode): P[] {
  return providers.flatMap(provider => {
    if (provider.signIn.length === 0) return [provider];
    const signIn = signInMethodsFor(provider.signIn, mode);
    if (signIn.length === 0) return [];
    return [signIn.length === provider.signIn.length ? provider : { ...provider, signIn }];
  });
}

/** Thrown by `assertCredentialAllowed`. The message is fixed text, safe to show. */
export class CredentialModeError extends Error {
  readonly mode: CredentialMode;
  readonly kind: CredentialKind;
  constructor(mode: CredentialMode, kind: CredentialKind) {
    super(kind === 'api-key' ? 'API keys are turned off in this app.' : 'Subscription sign-in is turned off in this app.');
    this.name = 'CredentialModeError';
    this.mode = mode;
    this.kind = kind;
  }
}

/**
 * Guard for request paths: throws `CredentialModeError` before a credential of `kind` is used when
 * `mode` does not allow it, so a key stored under an earlier mode is never sent.
 */
export function assertCredentialAllowed(mode: CredentialMode, kind: CredentialKind): void {
  if (!allowsCredentialKind(mode, kind)) throw new CredentialModeError(mode, kind);
}
