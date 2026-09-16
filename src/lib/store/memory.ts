/**
 * In-memory Store for tests (CLAUDE.md §9: tests never touch the real EDB site or disk).
 * Also the shape a future KvStore copies — same keys, different backend.
 */
import type { CacheEntry, Index, LastCheck, Store } from './types.ts';

export class MemoryStore implements Store {
  private snapshots = new Map<string, string>();
  private cache = new Map<string, CacheEntry>();
  private index: Index | null = null;
  private status: LastCheck | null = null;
  /** Exposed so tests can assert on what was traced. */
  readonly traces: { kind: 'chat' | 'check'; line: object }[] = [];

  /** Seed fixtures without going through the write path. */
  constructor(seed?: { snapshots?: Record<string, string>; cache?: Record<string, CacheEntry> }) {
    for (const [slug, md] of Object.entries(seed?.snapshots ?? {})) this.snapshots.set(slug, md);
    for (const [slug, entry] of Object.entries(seed?.cache ?? {})) this.cache.set(slug, entry);
  }

  async listSnapshots(): Promise<string[]> {
    return [...this.snapshots.keys()].sort();
  }

  async readSnapshot(slug: string): Promise<string | null> {
    return this.snapshots.get(slug) ?? null;
  }

  async writeSnapshot(slug: string, md: string): Promise<void> {
    this.snapshots.set(slug, md);
  }

  async readCache(slug: string): Promise<CacheEntry | null> {
    return this.cache.get(slug) ?? null;
  }

  async writeCache(slug: string, entry: CacheEntry): Promise<void> {
    this.cache.set(slug, entry);
  }

  async readIndex(): Promise<Index | null> {
    return this.index;
  }

  async writeIndex(index: Index): Promise<void> {
    this.index = index;
  }

  async appendTrace(kind: 'chat' | 'check', line: object): Promise<void> {
    this.traces.push({ kind, line });
  }

  async readStatus(): Promise<LastCheck | null> {
    return this.status;
  }

  async writeStatus(s: LastCheck): Promise<void> {
    this.status = s;
  }
}
