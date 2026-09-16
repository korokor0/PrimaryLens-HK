/**
 * Build the retrieval index from whatever is currently in the Store.
 *
 * Kept separate from chunk/search so the same builder serves `runCrawl` (initial build) and
 * `runCheck` (rebuild after a baseline advances) without either importing the other.
 */
import { parseSnapshot } from '../snapshot/frontmatter.ts';
import type { Chunk, Index, Store } from '../store/types.ts';
import { chunkSnapshot } from './chunk.ts';
import { buildIndex } from './search.ts';

/**
 * Read every snapshot, chunk it, and compute the IDF table.
 *
 * The index is derived data: it is rebuilt from snapshots rather than updated in place, so it
 * can never drift from the baseline it describes.
 */
export async function buildIndexFromStore(store: Store): Promise<Index> {
  const chunks: Chunk[] = [];

  for (const slug of await store.listSnapshots()) {
    const markdown = await store.readSnapshot(slug);
    if (markdown === null) continue;

    const { meta, body } = parseSnapshot(markdown);
    const url = meta['url'];
    // A snapshot with no url cannot be cited, and §5.7 requires every answer to carry one.
    if (url === undefined || body === '') continue;

    chunks.push(...chunkSnapshot({ slug, title: meta['title'] ?? slug, url, body }));
  }

  return buildIndex(chunks);
}

export { chunkSnapshot } from './chunk.ts';
export { buildIndex, search, tokenize, NO_EVIDENCE_THRESHOLD, type SearchHit } from './search.ts';
