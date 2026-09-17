/**
 * The bounded agent loop: exactly one tool call per user turn (CLAUDE.md §5.6).
 *
 * The flow is deliberately not autonomous. The model does two things and nothing else:
 * it chooses search terms, and it writes an answer from evidence it was handed. Whether that
 * evidence is good enough is decided by application code, not by the model — so a question the
 * corpus cannot support can never be answered from model memory.
 *
 * The model is reached through the small `ChatModel` interface rather than the OpenAI SDK
 * directly, so tests can assert that the second call is never made (§9 test 5).
 */
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { Index } from '../store/types.ts';
import { NO_EVIDENCE_THRESHOLD } from '../retrieval/search.ts';
import { SEARCH_TOOL, SEARCH_TOOL_NAME, executeSearch, type ToolResultItem } from './tools.ts';
import {
  MAX_QUESTION_CHARS,
  SYSTEM_PROMPT,
  notFoundMessage,
  tooLongMessage,
} from './prompt.ts';
import { newTrace, type ChatTrace, type TracedSource } from './trace.ts';

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  /** Omitted entirely on the final call — see runChat. */
  tools?: typeof SEARCH_TOOL[];
  toolChoice?: 'required';
}

export interface ModelResponse {
  content: string | null;
  toolCalls: ModelToolCall[];
}

export interface ChatModel {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ChatDeps {
  /** Writes the grounded answer (call 2). */
  model: ChatModel;
  /** Optional cheaper model for choosing search terms (call 1). Defaults to `model`. */
  queryModel?: ChatModel | undefined;
  index: Index;
  /** The committed allowlist. A URL the model emits must appear here *and* in this turn's hits. */
  allowedUrls: Set<string>;
  exampleTopics: string[];
  threshold?: number;
}

export interface ChatResult {
  answer: string;
  /** True only when the answer came from the model with evidence behind it. */
  grounded: boolean;
  sources: TracedSource[];
  trace: ChatTrace;
}

/** Trailing punctuation is sentence punctuation, not part of the URL. */
const URL_PATTERN = /https?:\/\/[^\s<>()[\]{}「」『』，。；、：！？]+/g;

function canonical(url: string): string {
  try {
    const parsed = new URL(url.replace(/[.,;:)\]}]+$/, ''));
    parsed.protocol = 'https:';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Remove any URL the model produced that is not both (a) in this turn's tool results and
 * (b) on the committed allowlist. A fabricated or recalled link is the most damaging thing
 * this system could emit, because it looks exactly like a real citation (§5.7).
 */
export function sanitizeUrls(answer: string, allowed: Set<string>): { text: string; removed: string[] } {
  const removed: string[] = [];
  const text = answer.replace(URL_PATTERN, (match) => {
    const trailing = /[.,;:)\]}]+$/.exec(match)?.[0] ?? '';
    if (allowed.has(canonical(match))) return match;
    removed.push(match);
    return trailing;
  });
  // Removing a link leaves the surrounding sentence with doubled spaces; tidy them so the
  // answer still reads as a sentence.
  return { text: removed.length > 0 ? text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([。，、；])/g, '$1') : text, removed };
}

export async function runChat(deps: ChatDeps, question: string): Promise<ChatResult> {
  const { model, index, exampleTopics } = deps;
  // Canonicalise the allowlist once so the membership test below compares like with like:
  // hits are canonicalised, and a raw `http://` or fragment-bearing entry would never match.
  const allowedUrls = new Set([...deps.allowedUrls].map(canonical));
  const threshold = deps.threshold ?? NO_EVIDENCE_THRESHOLD;
  const trace = newTrace(question);
  const startedAt = Date.now();

  const finish = (answer: string, grounded: boolean, sources: TracedSource[], outcome: ChatTrace['outcome']): ChatResult => {
    trace.outcome = outcome;
    trace.totalMs = Date.now() - startedAt;
    return { answer, grounded, sources, trace };
  };

  const trimmed = question.trim();
  if (trimmed === '') {
    trace.steps.push({ type: 'guardrail', rule: 'empty_question', detail: 'question was blank' });
    return finish(notFoundMessage(trimmed, exampleTopics), false, [], 'rejected');
  }
  if (trimmed.length > MAX_QUESTION_CHARS) {
    trace.steps.push({
      type: 'guardrail',
      rule: 'max_question_chars',
      detail: `${trimmed.length} > ${MAX_QUESTION_CHARS}`,
    });
    return finish(tooLongMessage(trimmed), false, [], 'rejected');
  }

  // ---- Call 1: the model must call the search tool. It chooses the query; nothing else. ----
  const firstMessages: ModelMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: trimmed },
  ];

  // Picking search terms is the easy half of the job, so it may run on a cheaper model. The
  // answer never does: grounded Traditional Chinese synthesis is where model quality shows.
  const querier = deps.queryModel ?? model;
  const firstStarted = Date.now();
  const first = await querier.complete({
    messages: firstMessages,
    tools: [SEARCH_TOOL],
    toolChoice: 'required',
  });
  trace.steps.push({
    type: 'model_call',
    stage: 'tool_selection',
    model: querier.name,
    toolChoice: 'required',
    tools: [SEARCH_TOOL_NAME],
    ms: Date.now() - firstStarted,
  });

  const toolCall = first.toolCalls.find((call) => call.name === SEARCH_TOOL_NAME);

  // tool_choice:"required" should guarantee a call. If a provider ignores it, fall back to
  // searching the user's own words: the grounding rule must hold even when the model misbehaves.
  let query = trimmed;
  if (toolCall === undefined) {
    trace.steps.push({
      type: 'guardrail',
      rule: 'forced_tool_call_missing',
      detail: 'model returned no tool call despite tool_choice=required; searched the question verbatim',
    });
  } else {
    try {
      const parsed: unknown = JSON.parse(toolCall.arguments);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { query?: unknown }).query === 'string') {
        query = (parsed as { query: string }).query;
      }
    } catch {
      trace.steps.push({
        type: 'guardrail',
        rule: 'tool_arguments_unparseable',
        detail: 'tool arguments were not valid JSON; searched the question verbatim',
      });
    }
  }
  trace.steps.push({ type: 'tool_call', name: SEARCH_TOOL_NAME, arguments: { query } });

  // ---- Execute the tool ----
  const searchStarted = Date.now();
  const { hits, items } = executeSearch(index, query);
  const topScore = hits[0]?.score ?? 0;
  const passed = topScore >= threshold;
  const sources: TracedSource[] = hits.map((hit) => ({
    title: hit.title,
    url: hit.url,
    heading: hit.heading,
    score: hit.score,
  }));
  trace.steps.push({
    type: 'tool_result',
    name: SEARCH_TOOL_NAME,
    hits: hits.length,
    topScore,
    threshold,
    passed,
    sources,
    ms: Date.now() - searchStarted,
  });

  // ---- Below threshold: answer deterministically. The model is NOT given a second chance. ----
  if (!passed) {
    return finish(notFoundMessage(trimmed, exampleTopics), false, [], 'no_evidence');
  }

  // ---- Call 2: write the answer from this evidence. No tools are offered at all. ----
  // `tool_choice: "none"` is rejected by the API unless `tools` is also present, so the way to
  // disable tool use is to omit both. Verified against the live API before writing this.
  const secondMessages: ModelMessage[] = [
    ...firstMessages,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: toolCall?.id ?? 'call_forced',
          type: 'function',
          function: { name: SEARCH_TOOL_NAME, arguments: JSON.stringify({ query }) },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: toolCall?.id ?? 'call_forced',
      content: JSON.stringify(items satisfies ToolResultItem[]),
    },
  ];

  const secondStarted = Date.now();
  const second = await model.complete({ messages: secondMessages });
  trace.steps.push({
    type: 'model_call',
    stage: 'final_answer',
    model: model.name,
    toolChoice: 'none (tools omitted)',
    tools: [],
    ms: Date.now() - secondStarted,
  });

  const raw = second.content?.trim() ?? '';
  if (raw === '') {
    trace.steps.push({ type: 'guardrail', rule: 'empty_answer', detail: 'model returned no content' });
    return finish(notFoundMessage(trimmed, exampleTopics), false, sources, 'error');
  }

  // Only URLs from this turn's hits, and only if also on the committed allowlist.
  const citable = new Set<string>();
  for (const hit of hits) {
    const url = canonical(hit.url);
    if (allowedUrls.has(url)) citable.add(url);
  }
  const { text, removed } = sanitizeUrls(raw, citable);
  if (removed.length > 0) {
    trace.steps.push({
      type: 'guardrail',
      rule: 'url_not_in_evidence',
      detail: `removed ${removed.length} url(s) not in this turn's tool results: ${removed.join(', ')}`,
    });
  }

  return finish(text, true, sources, 'answered');
}

/**
 * OpenAI-backed ChatModel.
 *
 * Kept at the edge of this module so everything above it is provider-agnostic and testable
 * without a network call. Chat Completions with native function calling only — no JSON
 * tool-call fallback and no compatibility shims (CLAUDE.md §2).
 */
export function createOpenAIModel(options: { apiKey: string; baseUrl: string; model: string }): ChatModel {
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseUrl });

  return {
    name: options.model,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const response = await client.chat.completions.create({
        model: options.model,
        messages: request.messages as unknown as ChatCompletionMessageParam[],
        // Both omitted on the final call: the API rejects tool_choice without tools, so
        // omitting the pair is what actually disables tool use. Verified against the live API.
        ...(request.tools !== undefined ? { tools: request.tools as unknown as ChatCompletionTool[] } : {}),
        ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
      });

      const message = response.choices[0]?.message;
      const toolCalls: ModelToolCall[] = [];
      for (const call of message?.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        toolCalls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments });
      }

      return { content: message?.content ?? null, toolCalls };
    },
  };
}
