/**
 * `runCheck` — the daily comparison. One lifecycle, driven by both `pnpm check` and the UI
 * button (CLAUDE.md §6).
 *
 * Three rules from §5.3 shape every branch below, and all three exist because of the same
 * reviewer test — hand-editing one sentence in a committed snapshot:
 *
 *  1. This function NEVER calls a snapshot-writing crawl path before diffing. The snapshot on
 *     disk is the baseline; overwriting it first would destroy the very edit being detected.
 *  2. HTTP 304 means the *remote resource* is unchanged relative to our HTTP cache. It says
 *     nothing about the snapshot. On 304 the cached body is normalized and compared exactly as
 *     a 200 would be, because the reviewer's edit changes the snapshot while EDB stands still.
 *  3. The baseline advances only after a notification actually succeeded, or was explicitly
 *     skipped because no webhook is configured. A failed webhook keeps the old baseline so the
 *     next run retries — notification is at-least-once, never at-most-once.
 */
import type { WatchedPage } from './config.ts';
import type { LastCheck, PageStatus, Store } from './store/types.ts';
import { isAllowed, type PoliteFetcher, type RobotsRules } from './fetch/polite.ts';
import { normalize } from './snapshot/normalize.ts';
import { parseSnapshot, serializeSnapshot } from './snapshot/frontmatter.ts';
import { diffSnapshots, hashBody, type PageChange } from './snapshot/diff.ts';
import { summarizeChange } from './notify/summarize.ts';
import { buildPayload, postWebhook } from './notify/webhook.ts';
import { buildIndexFromStore } from './retrieval/index.ts';

export const WEBHOOK_SKIPPED_MESSAGE = '通知已略過：未設定 WEBHOOK_URL';

export interface CheckDeps {
  store: Store;
  fetcher: PoliteFetcher;
  pages: WatchedPage[];
  robots: RobotsRules;
  webhookUrl?: string | undefined;
  log?: (line: string) => void;
  now?: () => Date;
  /** Injectable so tests can drive the webhook without a network (§9 test 4). */
  fetchImpl?: typeof fetch;
}

export interface CheckOptions {
  /** Fetch, compare and print. No webhook, no snapshot writes, no index writes. */
  dryRun?: boolean;
  /** Deterministic demo: no EDB request at all; the candidate is built from the snapshot. */
  simulate?: { from: string; to: string };
}

export interface CheckResult {
  status: 'unchanged' | 'changed' | 'failed';
  changedPages: number;
  notified: boolean;
  pages: PageStatus[];
  changes: PageChange[];
  messages: string[];
}

export async function runCheck(deps: CheckDeps, options: CheckOptions = {}): Promise<CheckResult> {
  const { store, fetcher, pages, robots, webhookUrl } = deps;
  const log = deps.log ?? ((): void => {});
  const now = deps.now ?? ((): Date => new Date());
  const checkedAt = now();

  const dryRun = options.dryRun === true;
  const simulate = options.simulate;
  // Both modes are strictly read-only: §12 requires --dry-run never to write, and --simulate
  // must leave snapshot, cache and index untouched.
  const persist = !dryRun && simulate === undefined;

  const statuses: PageStatus[] = [];
  const allChanges: PageChange[] = [];
  const messages: string[] = [];
  let indexDirty = false;
  let anyNotified = false;

  for (const page of pages) {
    const base = { slug: page.slug, url: page.url, title: page.title };

    if (!isAllowed(robots, page.url)) {
      statuses.push({ ...base, status: 'skipped', note: 'robots.txt disallows this path' });
      log(`  skip ${page.slug}: robots.txt disallows this path`);
      continue;
    }

    // ---- Baseline: the committed snapshot, read and NOT written ----
    const snapshotFile = await store.readSnapshot(page.slug);
    if (snapshotFile === null) {
      statuses.push({ ...base, status: 'failed', note: 'no snapshot yet — run `pnpm crawl` first' });
      log(`  fail ${page.slug}: no snapshot yet — run \`pnpm crawl\` first`);
      continue;
    }
    const { meta, body: baseline } = parseSnapshot(snapshotFile);
    // The baseline's title. Replaced by the live page's title when the baseline advances,
    // otherwise a page EDB renames would keep its old title in every future citation.
    let title = meta['title'] ?? page.title;
    const adopt = (normalized: { title: string; body: string }): string => {
      if (normalized.title !== '') title = normalized.title;
      return normalized.body;
    };

    // ---- Candidate: the current live representation, normalized in memory ----
    let candidate: string;
    let freshHtml: string | null = null;

    if (simulate !== undefined) {
      // No network. The fake candidate is the baseline with one substring swapped, which
      // exercises the identical diff/summary/notify path with a predictable result.
      candidate = baseline.split(simulate.from).join(simulate.to);
    } else {
      const cached = await store.readCache(page.slug);
      let result;
      try {
        result = await fetcher.get(page.url, { etag: cached?.etag, lastModified: cached?.lastModified });
      } catch (err) {
        const note = err instanceof Error ? err.message : String(err);
        statuses.push({ ...base, status: 'failed', note });
        log(`  fail ${page.slug}: ${note}`);
        continue;
      }

      if (result.status === 304) {
        if (cached?.html !== undefined && cached.html !== '') {
          // 304 is a transport result, not a comparison result: fall through and diff.
          candidate = adopt(normalize(cached.html, page.url));
        } else {
          // Cached body missing or corrupt: retry once without conditional headers (§5.1).
          const retry = await fetcher.get(page.url);
          if (retry.status !== 200 || retry.html === null) {
            statuses.push({ ...base, status: 'failed', note: `304 with no usable cache, retry gave HTTP ${retry.status}` });
            log(`  fail ${page.slug}: 304 with no usable cache`);
            continue;
          }
          freshHtml = retry.html;
          candidate = adopt(normalize(retry.html, page.url));
        }
      } else if (result.status === 200 && result.html !== null) {
        freshHtml = result.html;
        candidate = adopt(normalize(result.html, page.url));
      } else {
        statuses.push({ ...base, status: 'failed', note: `HTTP ${result.status}` });
        log(`  fail ${page.slug}: HTTP ${result.status}`);
        continue;
      }

      // Refresh the last-known live representation. Independent of the baseline decision:
      // the cache is only ever "what the server last served us" (§13.4).
      if (persist && freshHtml !== null) {
        await store.writeCache(page.slug, {
          html: freshHtml,
          ...(result.etag !== undefined ? { etag: result.etag } : {}),
          ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
        });
      }
    }

    // ---- Compare. Hash is recomputed from the current snapshot body every run (§5.2) ----
    const [baselineHash, candidateHash] = await Promise.all([hashBody(baseline), hashBody(candidate)]);
    if (baselineHash === candidateHash) {
      statuses.push({ ...base, title, status: 'unchanged' });
      continue;
    }

    const changes = diffSnapshots({ title, url: page.url, baseline, candidate });
    if (changes.length === 0) {
      // Hashes differ but no sentence did: whitespace-only drift. Accept it silently rather
      // than send a notification that would say nothing.
      statuses.push({ ...base, title, status: 'unchanged', note: 'formatting-only difference' });
      if (persist) {
        await store.writeSnapshot(page.slug, serializeSnapshot({ url: page.url, title, fetched_at: checkedAt.toISOString() }, candidate));
        indexDirty = true;
      }
      continue;
    }

    const pageMessages = changes.map((change) => summarizeChange(change, checkedAt));
    allChanges.push(...changes);
    messages.push(...pageMessages);
    log(`  CHANGED ${page.slug}: ${changes.length} section(s)`);

    // ---- Notify, then decide whether the baseline may advance ----
    let sent: boolean;
    let note: string;
    if (dryRun) {
      sent = false;
      note = 'dry-run: no webhook sent, baseline unchanged';
    } else if (webhookUrl === undefined || webhookUrl === '') {
      // Explicit skip counts as delivered: there is no one to tell, so holding the baseline
      // back would make every future run repeat the same notification (§5.3).
      sent = true;
      note = WEBHOOK_SKIPPED_MESSAGE;
      log(`  ${WEBHOOK_SKIPPED_MESSAGE}`);
    } else {
      const results = await Promise.all(
        changes.map((change, i) =>
          postWebhook(webhookUrl, buildPayload(change, pageMessages[i] ?? '', checkedAt), deps.fetchImpl ?? fetch),
        ),
      );
      sent = results.every((r) => r.sent);
      note = sent ? 'notified' : `webhook failed: ${results.find((r) => !r.sent)?.detail ?? 'unknown'}`;
      if (sent) anyNotified = true;
      else log(`  ${note} — keeping old baseline so the next run retries`);
    }

    if (sent && persist) {
      await store.writeSnapshot(
        page.slug,
        serializeSnapshot({ url: page.url, title, fetched_at: checkedAt.toISOString() }, candidate),
      );
      indexDirty = true;
    }

    statuses.push({ ...base, title, status: 'changed', note });
  }

  // ---- After all pages ----
  if (indexDirty && persist) {
    const index = await buildIndexFromStore(store);
    await store.writeIndex(index);
    log(`  index rebuilt: ${index.chunkCount} chunk(s)`);
  }

  const failed = statuses.filter((s) => s.status === 'failed').length;
  const changedPages = statuses.filter((s) => s.status === 'changed').length;
  const status: CheckResult['status'] = failed > 0 ? 'failed' : changedPages > 0 ? 'changed' : 'unchanged';

  const result: CheckResult = {
    status,
    changedPages,
    notified: anyNotified,
    pages: statuses,
    changes: allChanges,
    messages,
  };

  if (persist) {
    const lastCheck: LastCheck = {
      checkedAt: checkedAt.toISOString(),
      status,
      changedPages,
      notified: anyNotified,
      pages: statuses,
    };
    await store.writeStatus(lastCheck);
    await store.appendTrace('check', {
      checkedAt: checkedAt.toISOString(),
      status,
      changedPages,
      notified: anyNotified,
      pages: statuses,
      messages,
    });
  }

  return result;
}
