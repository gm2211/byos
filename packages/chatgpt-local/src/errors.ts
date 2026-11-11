export type ChatGptErrorCode = 'storage-unavailable' | 'auth-failed' | 'reconnect-required' | 'consent-required' | 'quota' | 'unavailable' | 'unsupported' | 'invalid-response' | 'canceled' | 'busy';
const messages: Record<ChatGptErrorCode, string> = {
  'storage-unavailable': 'ChatGPT credentials could not be read or saved in protected storage.',
  'auth-failed': 'ChatGPT sign-in could not be verified. Try again.',
  'reconnect-required': 'Connect this ChatGPT account again.',
  'consent-required': 'Enable ChatGPT plan access before generating.',
  quota: 'ChatGPT usage is limited. Review your usage in ChatGPT settings.',
  unavailable: 'ChatGPT is temporarily unavailable. Try again later.',
  unsupported: 'This ChatGPT request or account is not supported.',
  'invalid-response': 'ChatGPT did not return a complete, valid answer.',
  canceled: 'ChatGPT request canceled.',
  busy: 'Another ChatGPT operation is active. Try again after it finishes.',
};
export class ChatGptError extends Error {
  readonly code: ChatGptErrorCode;
  readonly status?: number;
  /** `message` is only ever a sentence @byos/core wrote (busy, empty answer), never provider text. */
  constructor(code: ChatGptErrorCode, status?: number, options: { message?: string; cause?: unknown } = {}) { super(options.message ?? messages[code], { cause: options.cause }); this.name = 'ChatGptError'; this.code = code; this.status = status; }
}
export function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw new ChatGptError('canceled'); }
export function httpError(status: number): ChatGptError {
  return new ChatGptError(status === 401 ? 'reconnect-required' : status === 429 ? 'quota' : status === 403 || status === 400 ? 'unsupported' : 'unavailable', status);
}
