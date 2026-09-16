/**
 * Test 4 of §9: when the baseline is allowed to advance, and when it must not.
 *
 * §5.3's rule is that the baseline advances only after a notification actually succeeded, or
 * was explicitly skipped because no webhook is configured. The failure case is the one worth
 * testing: if a failed webhook still advanced the baseline, the change would be swallowed and
 * nobody would ever be told — the notification would be at-most-once instead of at-least-once.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/lib/store/memory.ts';
import { PoliteFetcher } from '../src/lib/fetch/polite.ts';
import { runCheck, WEBHOOK_SKIPPED_MESSAGE } from '../src/lib/check.ts';
import { normalize } from '../src/lib/snapshot/normalize.ts';
import { parseSnapshot, serializeSnapshot } from '../src/lib/snapshot/frontmatter.ts';

const URL_ = 'https://www.edb.gov.hk/tc/edu-system/primary-secondary/applicable-to-primary/whole-day-schooling/background/index.html';
const page = { slug: 'bg', url: URL_, title: '背景' };

const htmlWith = (sentence: string): string => `<div class="inner_page_content_container">
  <div class="generic_inner_page_paragraph_title"><h1 class="generic_inner_page_paragraph_title_h1">背景</h1></div>
  <div class="generic_page_content"><p>${sentence}</p></div>
</div>`;

const OLD = '本局於一九九三年開始逐步推行小學全日制。';
const NEW = '本局於二零二六年開始全面推行小學全日制。';

function storeWithBaseline(): MemoryStore {
  return new MemoryStore({
    snapshots: {
      bg: serializeSnapshot({ url: URL_, title: '背景', fetched_at: '2026-09-01T00:00:00.000Z' }, normalize(htmlWith(OLD), URL_).body),
    },
  });
}

/** The live page now says something new. */
const servingNew = (): typeof fetch =>
  (async () => new Response(htmlWith(NEW), { status: 200 })) as unknown as typeof fetch;

const check = (store: MemoryStore, extra: Partial<Parameters<typeof runCheck>[0]> = {}) =>
  runCheck({
    store,
    fetcher: new PoliteFetcher({ userAgent: 'test', delayMs: 0, fetchImpl: servingNew() }),
    pages: [page],
    robots: { disallow: [], fetched: true },
    ...extra,
  });

describe('baseline lifecycle', () => {
  it('advances the baseline when notification is explicitly skipped, and is then idempotent', async () => {
    const store = storeWithBaseline();

    const first = await check(store);
    expect(first.status).toBe('changed');
    expect(first.pages[0]?.note).toBe(WEBHOOK_SKIPPED_MESSAGE);

    // Baseline now holds the new text.
    expect(parseSnapshot((await store.readSnapshot('bg')) ?? '').body).toContain('二零二六年');
    // The index was rebuilt from the advanced baseline, not left describing the old one.
    expect((await store.readIndex())?.chunks.some((c) => c.text.includes('二零二六年'))).toBe(true);

    // Same live content again -> nothing to report.
    const second = await check(store);
    expect(second.status).toBe('unchanged');
    expect(second.changedPages).toBe(0);
  });

  it('advances the baseline after a webhook succeeds', async () => {
    const store = storeWithBaseline();
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;

    const result = await check(store, { webhookUrl: 'https://hooks.example.com/edb', fetchImpl });

    expect(result.notified).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(parseSnapshot((await store.readSnapshot('bg')) ?? '').body).toContain('二零二六年');

    const payload = JSON.parse(
      String((fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0]?.[1]?.body),
    );
    expect(Object.keys(payload).sort()).toEqual(['added', 'checked_at', 'heading', 'message', 'removed', 'title', 'url']);
    expect(payload.message).not.toContain('<'); // human-readable, never raw HTML
  });

  it('keeps the old baseline when the webhook fails, so the next run retries', async () => {
    const store = storeWithBaseline();
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;

    const result = await check(store, { webhookUrl: 'https://hooks.example.com/edb', fetchImpl: failing });

    expect(result.status).toBe('changed');
    expect(result.notified).toBe(false);
    // The critical assertion: the baseline still holds the OLD sentence.
    const body = parseSnapshot((await store.readSnapshot('bg')) ?? '').body;
    expect(body).toContain('一九九三年');
    expect(body).not.toContain('二零二六年');
  });

  it('writes nothing at all in --dry-run', async () => {
    const store = storeWithBaseline();
    const before = await store.readSnapshot('bg');

    const result = await runCheck(
      {
        store,
        fetcher: new PoliteFetcher({ userAgent: 'test', delayMs: 0, fetchImpl: servingNew() }),
        pages: [page],
        robots: { disallow: [], fetched: true },
      },
      { dryRun: true },
    );

    // It still reports the change — it just must not act on it.
    expect(result.status).toBe('changed');
    expect(await store.readSnapshot('bg')).toBe(before);
    expect(await store.readIndex()).toBeNull();
    expect(await store.readStatus()).toBeNull();
  });
});
