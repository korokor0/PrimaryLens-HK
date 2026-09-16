/**
 * Structured trace of one chat turn.
 *
 * CLAUDE.md §1.2 and §5.7: the trace records tool names, arguments, result metadata and
 * timings — the things an application actually did. It deliberately carries **no model
 * reasoning**: no chain-of-thought, no hidden scratchpad, not even the assistant's draft text
 * beyond the final answer that was shown to the user.
 */

export interface TracedSource {
  title: string;
  url: string;
  heading: string;
  score: number;
}

export type TraceStep =
  | { type: 'model_call'; stage: 'tool_selection' | 'final_answer'; model: string; toolChoice: string; tools: string[]; ms: number }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; name: string; hits: number; topScore: number; threshold: number; passed: boolean; sources: TracedSource[]; ms: number }
  | { type: 'guardrail'; rule: string; detail: string };

export interface ChatTrace {
  turnId: string;
  startedAt: string;
  question: string;
  outcome: 'answered' | 'no_evidence' | 'rejected' | 'error';
  steps: TraceStep[];
  totalMs: number;
}

export function newTrace(question: string): ChatTrace {
  return {
    turnId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    question,
    outcome: 'error',
    steps: [],
    totalMs: 0,
  };
}
