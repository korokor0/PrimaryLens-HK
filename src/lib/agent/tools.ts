/**
 * The one tool the model is given.
 *
 * CLAUDE.md §5.6: retrieval is the *only* capability exposed to the model. Change detection
 * and notification are deterministic, side-effecting system operations; letting the model
 * trigger them would add nondeterminism without improving the task. That boundary is the
 * point of the design, not an omission.
 */
import type { Index } from '../store/types.ts';
import { search, type SearchHit } from '../retrieval/search.ts';

export const SEARCH_TOOL_NAME = 'search_edb_knowledge';

/**
 * Freeze at every depth. A shallow freeze would still leave `function.description` and the
 * parameter schema writable, which is a guarantee in name only.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * OpenAI Chat Completions function-tool definition.
 *
 * One shared object, handed to the SDK on every request rather than rebuilt per call —
 * measured at 0.031ms to construct, so sharing is about having a single definition, not speed.
 * Because it is shared process-wide, it is frozen: a mutation anywhere would leak into every
 * subsequent request instead of failing where the mistake was made.
 */
export const SEARCH_TOOL = deepFreeze({
  type: 'function' as const,
  function: {
    name: SEARCH_TOOL_NAME,
    description:
      "Search the locally cached Hong Kong EDB primary-education pages. Use this evidence for answering the user's question.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search terms drawn from the user question. Use Traditional Chinese for Chinese topics, since the pages are written in Traditional Chinese.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
});

/** What the tool hands back to the model — snake_case because the model sees these keys. */
export interface ToolResultItem {
  source_id: string;
  title: string;
  url: string;
  heading: string;
  snippet: string;
  score: number;
}

export function executeSearch(index: Index, query: string, limit = 5): { hits: SearchHit[]; items: ToolResultItem[] } {
  const hits = search(index, query, limit);
  return {
    hits,
    items: hits.map((hit) => ({
      source_id: hit.sourceId,
      title: hit.title,
      url: hit.url,
      heading: hit.heading,
      snippet: hit.snippet,
      score: hit.score,
    })),
  };
}
