/** Claude Messages request shaping shared by every BYOS app (TypeScript and ByosCore Swift).
 *  Ported from Skim (provider.rs, NativeAI.swift); vectors in conformance/request-shaping.json. */
import { CLAUDE_CODE_SYSTEM_PREFIX } from './claude-oauth.js';

export type ClaudeModelVersion = { major: number; minor: number };

/** Major/minor version from a Claude model id, or undefined for an id that isn't one.
 *  "claude-3-5-sonnet-…" names the version first; "claude-sonnet-4-6" the family first.
 *  A 1-2 digit second part is the minor version; a date snapshot ("4-20250514") is x.0. */
export function claudeModelVersion(model: string): ClaudeModelVersion | undefined {
  const parts = model.toLowerCase().split('-');
  if (parts.shift() !== 'claude') return undefined;
  if (parts[0] !== undefined && !/^\d+$/.test(parts[0])) parts.shift();
  if (!/^\d+$/.test(parts[0] ?? '')) return undefined;
  const next = parts[1];
  const minor = next !== undefined && next.length <= 2 && /^\d+$/.test(next) ? Number(next) : 0;
  return { major: Number(parts[0]), minor };
}

/** Claude Opus/Sonnet 4.7 and later, and every 5-series model, answer a `temperature` field with a 400.
 *  True only for Claude 3.x and 4.0-4.6; an unrecognised model gets the API's default sampling. */
export function claudeAcceptsTemperature(model: string): boolean {
  const version = claudeModelVersion(model);
  if (!version) return false;
  return version.major < 4 || (version.major === 4 && version.minor <= 6);
}

/** Every 5-series model thinks before answering unless told otherwise and takes `output_config.effort`.
 *  Older models think only when asked, and some (Sonnet 4.5, Haiku 4.5) reject `effort`. */
export function claudeThinksByDefault(model: string): boolean {
  return (claudeModelVersion(model)?.major ?? 0) >= 5;
}

/** Smallest `max_tokens` sent to a model that thinks, so thinking can't use the whole budget. */
export const CLAUDE_THINKING_MAX_TOKENS_FLOOR = 4096;
/** Temperature sent to models that take one when the caller doesn't choose. */
export const CLAUDE_DEFAULT_TEMPERATURE = 0.2;

export type ClaudeSystemBlock = { type: 'text'; text: string };

/** The `system` field: a plain string for an API key; for a subscription token, the Claude Code identity
 *  line as its own first block, then the app's instructions. Without that line Anthropic answers a
 *  subscription request with a bare 429 "Error". */
export function claudeSystem(instructions: string, subscription: boolean): string | ClaudeSystemBlock[] {
  if (!subscription) return instructions;
  return [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }, ...(instructions ? [{ type: 'text' as const, text: instructions }] : [])];
}

export type ClaudeBodyInput = {
  model: string;
  messages: unknown[];
  instructions?: string;
  subscription: boolean;
  maxTokens: number;
  /** Used only for models that take one; defaults to CLAUDE_DEFAULT_TEMPERATURE there. */
  temperature?: number;
  /** An effort the person chose. Adds adaptive thinking at that effort. Without it, a model that
   *  thinks by default gets low effort, so a small budget isn't spent thinking. */
  effort?: string;
  stream?: boolean;
  tools?: unknown[];
};

/** The Messages API body, with Skim's rules: temperature only where accepted; low effort and a
 *  max-tokens floor for models that think, so the answer isn't empty ("ran out of room"). */
export function shapeClaudeBody(input: ClaudeBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    system: claudeSystem(input.instructions ?? '', input.subscription),
    messages: input.messages,
    max_tokens: input.maxTokens,
  };
  if (input.stream) body.stream = true;
  if (claudeAcceptsTemperature(input.model) && !input.effort) body.temperature = input.temperature ?? CLAUDE_DEFAULT_TEMPERATURE;
  if (input.effort) {
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort: input.effort };
  } else if (claudeThinksByDefault(input.model)) {
    body.output_config = { effort: 'low' };
  }
  if (input.effort || claudeThinksByDefault(input.model)) body.max_tokens = Math.max(input.maxTokens, CLAUDE_THINKING_MAX_TOKENS_FLOOR);
  if (input.tools?.length) body.tools = input.tools;
  return body;
}

/** What to tell the reader when a response carries no text, by `stop_reason`. */
export function claudeEmptyResponseMessage(stopReason: string | undefined | null): string {
  switch (stopReason) {
    case 'max_tokens': return 'Claude ran out of room before it wrote an answer. Try again, or ask a narrower question.';
    case 'refusal': return 'Claude declined to answer this. Try rephrasing the question.';
    default: return 'The Claude response was empty.';
  }
}
