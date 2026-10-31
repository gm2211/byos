export type ClaudeErrorCode = 'storage-unavailable' | 'auth-failed' | 'reconnect-required' | 'quota' | 'unavailable' | 'unsupported' | 'invalid-response' | 'canceled' | 'busy' | 'port-in-use';
const messages: Record<ClaudeErrorCode, string> = {
  'storage-unavailable': 'Claude credentials could not be read or saved in protected storage.',
  'auth-failed': 'Claude sign-in could not be verified. Try again.',
  'reconnect-required': 'Sign in with Claude again.',
  quota: 'Claude usage is limited. Review your usage in Claude settings.',
  unavailable: 'Claude is temporarily unavailable. Try again later.',
  unsupported: 'This Claude request or account is not supported.',
  'invalid-response': 'Claude did not return a complete, valid answer.',
  canceled: 'Claude request canceled.',
  busy: 'Another Claude operation is active. Try again after it finishes.',
  'port-in-use': 'The local sign-in port is busy. Use the paste-code sign-in instead.',
};
export class ClaudeError extends Error {
  readonly code: ClaudeErrorCode;
  readonly status?: number;
  constructor(code: ClaudeErrorCode, status?: number) { super(messages[code]); this.name = 'ClaudeError'; this.code = code; this.status = status; }
}
export function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw new ClaudeError('canceled'); }
export function httpError(status: number): ClaudeError {
  return new ClaudeError(status === 401 ? 'reconnect-required' : status === 429 || status === 529 ? 'quota' : status === 403 || status === 400 || status === 404 ? 'unsupported' : 'unavailable', status);
}
