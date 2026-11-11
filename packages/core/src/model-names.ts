/** Short model names a person would say, shared by TypeScript and ByosCore Swift.
 *  Ported from Skim's ModelCatalog.friendlyName; vectors in conformance/text-polish.json. */

/** Model families whose ids read as words plus a version ("grok-4-1-fast" is "Grok 4.1 Fast"). */
const WORD_FAMILIES = ['grok', 'gemini', 'gemma', 'llama', 'mistral', 'qwen', 'deepseek', 'kimi'];
const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

const isDigits = (part: string) => /^\d+$/.test(part);
const isVersion = (part: string) => part.length <= 2 && isDigits(part);
const capitalized = (part: string) => part.slice(0, 1).toUpperCase() + part.slice(1);

/** Words capitalized, runs of short numbers joined by "." ("4", "1" is "4.1"). */
function words(parts: string[]): string[] {
  const out: string[] = [];
  let lastWasVersion = false;
  for (const part of parts) {
    if (isVersion(part) && lastWasVersion && out.length) out.push(`${out.pop()}.${part}`);
    else out.push(isVersion(part) ? part : capitalized(part));
    lastWasVersion = isVersion(part);
  }
  return out;
}

/**
 * A short name for a provider's model id, for picker buttons and menu rows: "claude-sonnet-5-5" is
 * "Sonnet 5.5", "anthropic/claude-3-5-haiku-20241022" is "Haiku 3.5", "gpt-4o-mini" is "GPT-4o mini",
 * "x-ai/grok-4-1-fast" is "Grok 4.1 Fast". A ":batch" style tag survives as "(batch)". An id from a
 * family it does not know comes back unchanged.
 */
export function friendlyModelName(id: string): string {
  let name = id.trim();
  let tag = '';
  const colon = name.indexOf(':');
  if (colon >= 0) {
    const rest = name.slice(colon + 1);
    if (rest) tag = ` (${rest})`;
    name = name.slice(0, colon);
  }
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);
  const parts = name.toLowerCase().split('-').filter(part => part.length > 0);
  const last = parts[parts.length - 1];
  if (last !== undefined && (last === 'latest' || (last.length === 8 && isDigits(last)))) parts.pop();
  // OpenAI's dated snapshots end "-2024-08-06".
  if (parts.length > 3) {
    const tail = parts.slice(-3);
    if (tail.map(part => part.length).join() === '4,2,2' && tail.every(isDigits)) parts.splice(-3);
  }
  const first = parts[0];
  if (first === undefined) return id;

  if (first === 'claude') {
    const familyIndex = parts.findIndex(part => CLAUDE_FAMILIES.includes(part));
    if (familyIndex < 0) return id;
    const rest = parts.slice(1);
    const version = rest.filter(isVersion).join('.');
    const extra = rest.filter((part, offset) => offset + 1 !== familyIndex && !isVersion(part)).map(capitalized);
    return [capitalized(parts[familyIndex]!), ...(version ? [version] : []), ...extra].join(' ') + tag;
  }
  if (first === 'gpt' && parts.length > 1) {
    let version = parts[1]!;
    let rest = parts.slice(2);
    if (isVersion(version) && rest[0] !== undefined && isVersion(rest[0])) {
      version += `.${rest[0]}`;
      rest = rest.slice(1);
    }
    return [`GPT-${version}`, ...rest].join(' ') + tag;
  }
  if (WORD_FAMILIES.some(family => first.startsWith(family))) return words(parts).join(' ') + tag;
  return id;
}
