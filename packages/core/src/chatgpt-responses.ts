/** ChatGPT-plan Responses API shaping and stream reading, shared by TypeScript and ByosCore Swift.
 *  Ported from Skim (NativeChatGPT.swift); vectors in conformance/request-shaping.json.
 *  Plan usage refuses sampling and length fields, so none are sent; `store: false` keeps turns off
 *  the account's history; the answer is complete only at `response.completed`. */

export type ChatTurn = { role: 'system' | 'user' | 'assistant'; content: string };
export type ResponsesInputItem = { role: 'user' | 'assistant'; content: { type: 'input_text' | 'output_text'; text: string }[] };

/** Conversation turns as Responses `input`; system turns are dropped (they go in `instructions`). */
export function chatGPTResponsesInput(turns: ChatTurn[]): ResponsesInputItem[] {
  return turns.filter(turn => turn.role !== 'system').map(turn => {
    const assistant = turn.role === 'assistant';
    return { role: assistant ? 'assistant' : 'user', content: [{ type: assistant ? 'output_text' : 'input_text', text: turn.content ?? '' }] };
  });
}

/** The request body. The first non-empty system turn wins over `instructions`. */
export function shapeChatGPTBody(input: { model: string; instructions?: string; turns: ChatTurn[] }): Record<string, unknown> {
  const system = input.turns.find(turn => turn.role === 'system' && turn.content)?.content ?? input.instructions ?? '';
  return { model: input.model, instructions: system, input: chatGPTResponsesInput(input.turns), store: false, stream: true };
}

/** Text of a finished response object: every `output_text` part, in order. */
export function chatGPTOutputText(response: unknown): string {
  const output = (response as { output?: unknown })?.output;
  if (!Array.isArray(output)) return '';
  return output.flatMap(item => Array.isArray((item as { content?: unknown })?.content) ? (item as { content: unknown[] }).content : [])
    .filter(part => (part as { type?: unknown })?.type === 'output_text')
    .map(part => (part as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

export class ChatGPTResponseError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = 'ChatGPTResponseError'; }
}

const PLAN_MESSAGES: Record<string, (app: string) => string> = {
  subscription_sharing_usage_limit_exceeded: app => `Your ChatGPT plan's limit for ${app} is used up. Raise it in ChatGPT's usage settings or wait for it to reset.`,
  subscription_sharing_user_not_eligible: () => "This ChatGPT account's plan can't be used in other apps. Plus and Pro plans can.",
  subscription_sharing_usage_unavailable: () => 'ChatGPT plan usage is unavailable right now. Try again shortly.',
  subscription_sharing_user_unavailable: () => 'ChatGPT plan usage is unavailable right now. Try again shortly.',
  subscription_sharing_invalid_user: () => 'ChatGPT needs you to sign in again. Open Settings to reconnect.',
  chatpass_v2_scope_not_authorized: () => 'ChatGPT needs you to sign in again. Open Settings to reconnect.',
  chatpass_v2_invalid_authorization_context: () => 'ChatGPT needs you to sign in again. Open Settings to reconnect.',
};

/** A plain sentence for a Responses error code and message. */
export function chatGPTFriendlyError(code: string | undefined | null, message: string | undefined | null, appName = 'this app'): string {
  const known = code ? PLAN_MESSAGES[code] : undefined;
  if (known) return known(appName);
  if (message) return `ChatGPT couldn't run this request: ${message.length > 240 ? `${message.slice(0, 240)}…` : message}`;
  return "ChatGPT couldn't run this request. Try again.";
}

/** Reads a Responses SSE stream one line at a time. */
export class ChatGPTResponsesStream {
  text = '';
  completed = false;
  constructor(private readonly appName = 'this app') {}

  /** Takes one SSE line; returns true when the response is complete. Throws ChatGPTResponseError on failure. */
  consume(line: string): boolean {
    if (!line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return false;
    let event: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(payload); if (!parsed || typeof parsed !== 'object') return false; event = parsed as Record<string, unknown>; } catch { return false; }
    const response = event.response as Record<string, unknown> | undefined;
    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') this.text += event.delta;
        return false;
      case 'response.completed':
        if (!this.text && response) this.text = chatGPTOutputText(response);
        this.completed = true;
        return true;
      case 'response.incomplete': {
        if (!this.text && response) this.text = chatGPTOutputText(response);
        if (!this.text) {
          const reason = (response?.incomplete_details as { reason?: unknown } | undefined)?.reason;
          throw new ChatGPTResponseError(`ChatGPT stopped before answering${typeof reason === 'string' ? ` (${reason})` : ''}.`);
        }
        this.completed = true;
        return true;
      }
      case 'response.failed': {
        const error = (response?.error ?? {}) as { code?: unknown; message?: unknown };
        const code = typeof error.code === 'string' ? error.code : undefined;
        throw new ChatGPTResponseError(chatGPTFriendlyError(code, typeof error.message === 'string' ? error.message : undefined, this.appName), code);
      }
      case 'error': {
        const error = (event.error && typeof event.error === 'object' ? event.error : event) as { code?: unknown; message?: unknown };
        const code = typeof error.code === 'string' ? error.code : undefined;
        throw new ChatGPTResponseError(chatGPTFriendlyError(code, typeof error.message === 'string' ? error.message : undefined, this.appName), code);
      }
      default:
        return false;
    }
  }

  /** The trimmed answer; throws when the stream ended early or carried no text. */
  finish(): string {
    if (!this.completed) throw new ChatGPTResponseError("ChatGPT's answer was cut off. Try again.");
    const trimmed = this.text.trim();
    if (!trimmed) throw new ChatGPTResponseError('The ChatGPT response was empty.');
    return trimmed;
  }
}
