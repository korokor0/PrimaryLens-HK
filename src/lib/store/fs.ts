/**
 * Filesystem-backed Store — the local/VPS path the reviewer actually runs.
 *
 * This is the ONLY file in src/lib permitted to import `node:*` (CLAUDE.md §2).
 * Keeping the import surface here is what lets the same lifecycle code run on a Worker.
 */
import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheEntry, Index, LastCheck, Store } from './types.ts';

export class FsStore implements Store {
  constructor(private readonly root: string) {}

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  /** Directories are created lazily; a fresh clone has no data/cache or data/index. */
  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      // Missing file and corrupt JSON are both "no usable value"; callers re-derive.
      return null;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await this.ensureDir(join(file, '..'));
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }

  async listSnapshots(): Promise<string[]> {
    try {
      const names = await readdir(this.path('snapshots'));
      return names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)).sort();
    } catch {
      return [];
    }
  }

  async readSnapshot(slug: string): Promise<string | null> {
    try {
      return await readFile(this.path('snapshots', `${slug}.md`), 'utf8');
    } catch {
      return null;
    }
  }

  async writeSnapshot(slug: string, md: string): Promise<void> {
    await this.ensureDir(this.path('snapshots'));
    await writeFile(this.path('snapshots', `${slug}.md`), md, 'utf8');
  }

  async readCache(slug: string): Promise<CacheEntry | null> {
    return this.readJson<CacheEntry>(this.path('cache', `${slug}.json`));
  }

  async writeCache(slug: string, entry: CacheEntry): Promise<void> {
    await this.writeJson(this.path('cache', `${slug}.json`), entry);
  }

  async readIndex(): Promise<Index | null> {
    return this.readJson<Index>(this.path('index', 'index.json'));
  }

  async writeIndex(index: Index): Promise<void> {
    await this.writeJson(this.path('index', 'index.json'), index);
  }

  /** One JSONL file per kind per UTC day; each line is one structured event. */
  async appendTrace(kind: 'chat' | 'check', line: object): Promise<void> {
    await this.ensureDir(this.path('trace'));
    const day = new Date().toISOString().slice(0, 10);
    await appendFile(this.path('trace', `${kind}-${day}.jsonl`), JSON.stringify(line) + '\n', 'utf8');
  }

  async readStatus(): Promise<LastCheck | null> {
    return this.readJson<LastCheck>(this.path('last-check.json'));
  }

  async writeStatus(s: LastCheck): Promise<void> {
    await this.writeJson(this.path('last-check.json'), s);
  }
}
