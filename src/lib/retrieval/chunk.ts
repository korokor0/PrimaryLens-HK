/**
 * Split a snapshot body into retrievable passages.
 *
 * Section-aware, because normalize.ts promoted EDB's standalone `<strong>` titles to `##`
 * headings — that heading is what gives each chunk a citable section name and what the
 * search scorer applies its heading bonus to (CLAUDE.md §5.5).
 */
import type { Chunk } from '../store/types.ts';

/** §5.5 asks for roughly 300-600 Chinese characters per chunk. */
export const MAX_CHUNK_CHARS = 600;

interface Section {
  heading: string;
  lines: string[];
}

/** Group body lines under the `## ` heading that precedes them. */
function splitSections(body: string, fallbackHeading: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: fallbackHeading, lines: [] };

  for (const line of body.split('\n')) {
    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined) {
      if (current.lines.length > 0) sections.push(current);
      current = { heading: heading[1].trim(), lines: [] };
      continue;
    }
    if (line.trim() !== '') current.lines.push(line.trim());
  }
  if (current.lines.length > 0) sections.push(current);
  return sections;
}

/**
 * One snapshot -> its chunks. Long sections are split on line boundaries rather than
 * mid-sentence, so a cited snippet always reads as whole lines.
 */
export function chunkSnapshot(args: {
  slug: string;
  title: string;
  url: string;
  body: string;
}): Chunk[] {
  const { slug, title, url, body } = args;
  const chunks: Chunk[] = [];

  const push = (heading: string, lines: string[]): void => {
    const text = lines.join('\n').trim();
    if (text === '') return;
    chunks.push({ sourceId: `${slug}:${chunks.length}`, title, url, heading, text });
  };

  for (const section of splitSections(body, title)) {
    let buffer: string[] = [];
    let size = 0;

    for (const line of section.lines) {
      // Flush before overflowing, unless nothing is buffered yet: a single over-long line
      // becomes its own chunk rather than being cut mid-sentence.
      if (size > 0 && size + line.length > MAX_CHUNK_CHARS) {
        push(section.heading, buffer);
        buffer = [];
        size = 0;
      }
      buffer.push(line);
      size += line.length;
    }
    push(section.heading, buffer);
  }

  return chunks;
}
