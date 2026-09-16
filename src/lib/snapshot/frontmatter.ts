/**
 * The snapshot file format: YAML-ish frontmatter, then the normalized body.
 *
 * Deliberately not a YAML parser. Frontmatter here is metadata only — three flat string
 * fields this code writes itself — and CLAUDE.md §5.2 requires that comparison and hashing
 * use the **body alone**, so the parser's one real job is to hand back the body unchanged.
 * A general YAML dependency would buy nothing and would be harder to explain.
 */

export interface SnapshotMeta {
  url: string;
  title: string;
  fetched_at: string;
}

export interface ParsedSnapshot {
  meta: Record<string, string>;
  /** Everything after the frontmatter. This is what gets hashed and diffed. */
  body: string;
}

const DELIMITER = '---';

/** Metadata values are single-line by construction; fold any newline so the file stays parseable. */
function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').trim();
}

export function serializeSnapshot(meta: SnapshotMeta, body: string): string {
  const lines = [
    DELIMITER,
    `url: ${oneLine(meta.url)}`,
    `title: ${oneLine(meta.title)}`,
    `fetched_at: ${oneLine(meta.fetched_at)}`,
    DELIMITER,
    '',
    body.trim(),
    '',
  ];
  return lines.join('\n');
}

/**
 * Split a snapshot file into metadata and body.
 *
 * A file with no frontmatter is treated as all body. That matters because a reviewer edits
 * these files by hand: if they damage the header, the checker should still compare content
 * rather than fail the run.
 */
export function parseSnapshot(markdown: string): ParsedSnapshot {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(`${DELIMITER}\n`)) {
    return { meta: {}, body: normalized.trim() };
  }

  const end = normalized.indexOf(`\n${DELIMITER}`, DELIMITER.length);
  if (end === -1) return { meta: {}, body: normalized.trim() };

  const header = normalized.slice(DELIMITER.length + 1, end);
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1);

  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (key !== '') meta[key] = line.slice(separator + 1).trim();
  }
  return { meta, body: body.trim() };
}
