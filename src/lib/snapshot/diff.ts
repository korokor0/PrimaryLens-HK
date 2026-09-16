/**
 * Section- and sentence-level comparison of two snapshot bodies (CLAUDE.md §5.4).
 *
 * Never HTML: the reviewer, and whoever receives the notification, should read what changed
 * in the words of the page. Diffing whole bodies as text would report a wall of noise, so
 * bodies are split into sections (the `##` headings normalize.ts produced) and then into
 * sentences, and only the sentences that actually differ are reported.
 */
import { diffArrays } from 'diff';

export interface PageChange {
  title: string;
  url: string;
  heading?: string;
  added: string[];
  removed: string[];
}

/**
 * Chinese sentence boundaries. §5.4 requires 。！？； at minimum; the closing brackets are
 * included because EDB writes 「…。」 and the quote belongs with the sentence it closes.
 * Line breaks also end a sentence — snapshot bodies are one idea per line.
 */
const SENTENCE_END = /[。！？；]+[」』）]*/g;

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let start = 0;
    SENTENCE_END.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_END.exec(trimmed)) !== null) {
      const end = match.index + match[0].length;
      const sentence = trimmed.slice(start, end).trim();
      if (sentence !== '') out.push(sentence);
      start = end;
    }
    // Text after the last terminator, or a line with no terminator at all (headings, list items).
    const tail = trimmed.slice(start).trim();
    if (tail !== '') out.push(tail);
  }
  return out;
}

interface Section {
  heading: string;
  sentences: string[];
}

/** Group a body's sentences under the `##` heading that precedes them. */
export function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let heading = '';
  let lines: string[] = [];

  const flush = (): void => {
    if (lines.length === 0) return;
    sections.push({ heading, sentences: splitSentences(lines.join('\n')) });
    lines = [];
  };

  for (const line of body.split('\n')) {
    const match = /^#{2,6}\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      heading = match[1].trim();
      continue;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/**
 * Compare two bodies, producing one PageChange per section that differs.
 *
 * Sections are matched by heading rather than position, so inserting a new section does not
 * report every later section as rewritten.
 */
export function diffSnapshots(args: {
  title: string;
  url: string;
  baseline: string;
  candidate: string;
}): PageChange[] {
  const { title, url, baseline, candidate } = args;

  const before = new Map<string, string[]>();
  for (const section of splitSections(baseline)) {
    before.set(section.heading, [...(before.get(section.heading) ?? []), ...section.sentences]);
  }
  const after = new Map<string, string[]>();
  for (const section of splitSections(candidate)) {
    after.set(section.heading, [...(after.get(section.heading) ?? []), ...section.sentences]);
  }

  // Candidate order first, so a report reads in the order the live page now presents it.
  const headings = [...new Set([...after.keys(), ...before.keys()])];
  const changes: PageChange[] = [];

  for (const heading of headings) {
    const added: string[] = [];
    const removed: string[] = [];

    for (const part of diffArrays(before.get(heading) ?? [], after.get(heading) ?? [])) {
      if (part.added === true) added.push(...part.value);
      else if (part.removed === true) removed.push(...part.value);
    }

    if (added.length > 0 || removed.length > 0) {
      changes.push({ title, url, ...(heading !== '' ? { heading } : {}), added, removed });
    }
  }

  return changes;
}

/**
 * SHA-256 of a snapshot **body**.
 *
 * §5.2: the hash is recomputed from the current snapshot on every check and never persisted.
 * Persisting it would let the stored hash and the editable file disagree — precisely the gap
 * a reviewer's hand-edit would fall into.
 */
export async function hashBody(body: string): Promise<string> {
  const data = new TextEncoder().encode(body.trim());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
