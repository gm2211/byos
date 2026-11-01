export type GrokErrorCode = 'storage-unavailable' | 'auth-failed' | 'declined' | 'expired' | 'reconnect-required' | 'unavailable' | 'invalid-response' | 'canceled' | 'busy';
const messages: Record<GrokErrorCode, string> = {
  'storage-unavailable': 'Grok credentials could not be read or saved in protected storage.',
  'auth-failed': 'Grok sign-in could not be verified. Try again.',
  declined: 'Grok sign-in was declined.',
  expired: 'The Grok sign-in code expired. Start again.',
  'reconnect-required': 'Sign in with Grok again.',
  unavailable: 'Grok is temporarily unavailable. Try again later.',
  'invalid-response': 'Grok did not return a valid response.',
  canceled: 'Grok request canceled.',
  busy: 'Another Grok operation is active. Try again after it finishes.',
};
/** Fixed text only; never anything xAI said. `status` carries an HTTP status when one is known. */
export class GrokError extends Error {
  readonly code: GrokErrorCode;
  readonly status?: number;
  constructor(code: GrokErrorCode, status?: number) { super(messages[code]); this.name = 'GrokError'; this.code = code; this.status = status; }
}
export function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw new GrokError('canceled'); }
