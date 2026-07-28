// Which provider does a model string belong to?
//
// The runner resolves this properly: boardex_runner/provider.py asks LiteLLM
// (`get_llm_provider`), which knows the provider tables — that is how a bare
// `claude-sonnet-4-6` resolves to `anthropic` while containing neither the word nor a
// slash. The browser has no such table and must not pretend to have one.
//
// So this reads exactly the ONE form that is unambiguous without a table: the explicit
// `<provider>/<model...>` prefix that the runner's own default model uses
// (`openrouter/anthropic/claude-sonnet-4.6` → `openrouter`). Everything else derives
// NOTHING — the caller then says nothing about credentials, which is the honest answer:
// we do not know which provider that model needs, and guessing would either warn about
// a key that is not required or stay silent about one that is.

/**
 * The provider named by a model string's prefix, lowercased — or undefined when the
 * string carries no prefix to read (a bare model name, an empty segment, whitespace).
 */
export function providerForModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf('/');
  if (slash <= 0) return undefined; // no prefix at all, or a leading "/"
  const prefix = model.slice(0, slash).trim().toLowerCase();
  return prefix.length > 0 ? prefix : undefined;
}
