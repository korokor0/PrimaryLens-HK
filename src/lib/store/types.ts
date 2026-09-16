/**
 * The single persistence boundary for the whole app.
 *
 * Everything stateful goes through this interface so that `src/lib` never touches a
 * filesystem directly. `FsStore` backs the local/VPS path the reviewer runs; `MemoryStore`
 * backs the tests; a `KvStore` for Cloudflare Workers can be added later without any
 * change to the lifecycle code (CLAUDE.md §2, §11).
 */

/** One watched page's last-known *live* HTTP representation plus its cache validators. */
export interface CacheEntry {
  html: string;
  etag?: string;
  lastModified?: string;
}

/** One retrievable passage. Carries its provenance so every answer can cite it. */
export interface Chunk {
  sourceId: string;
  title: string;
  url: string;
  heading: string;
  text: string;
}

/** The generated retrieval index: chunks plus the IDF table computed over them. */
export interface Index {
  builtAt: string;
  chunks: Chunk[];
  /** bigram -> inverse document frequency */
  idf: Record<string, number>;
  chunkCount: number;
}

/** Per-page outcome of one check run. */
export interface PageStatus {
  slug: string;
  url: string;
  title: string;
  status: 'unchanged' | 'changed' | 'skipped' | 'failed';
  note?: string;
}

/** Summary of the most recent check run, surfaced by the UI's Source Monitor panel. */
export interface LastCheck {
  checkedAt: string;
  status: 'unchanged' | 'changed' | 'failed';
  changedPages: number;
  notified: boolean;
  pages: PageStatus[];
}

export interface Store {
  /** Slugs of every committed snapshot. */
  listSnapshots(): Promise<string[]>;
  /** Full snapshot markdown including frontmatter, or null if absent. */
  readSnapshot(slug: string): Promise<string | null>;
  writeSnapshot(slug: string, md: string): Promise<void>;

  readCache(slug: string): Promise<CacheEntry | null>;
  writeCache(slug: string, entry: CacheEntry): Promise<void>;

  readIndex(): Promise<Index | null>;
  writeIndex(index: Index): Promise<void>;

  /** Append one JSONL record of agent or check activity. */
  appendTrace(kind: 'chat' | 'check', line: object): Promise<void>;

  readStatus(): Promise<LastCheck | null>;
  writeStatus(s: LastCheck): Promise<void>;
}
