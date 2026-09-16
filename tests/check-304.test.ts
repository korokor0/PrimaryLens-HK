/**
 * Test 3 of §9 — the regression this whole project turns on.
 *
 * The reviewer hand-edits one sentence in a committed snapshot while the remote EDB page is
 * unchanged. A server that answers conditional requests will then return 304 with no body.
 * The tempting implementation — "304 means nothing changed, skip this page" — passes every
 * happy-path test and fails the only test that matters.
 *
 * §5.3: 304 is a statement about the HTTP cache, never about the snapshot.
 *
 * This cannot be covered by testing against the live site: EDB sends no ETag or Last-Modified
 * at all, so a real 304 never occurs there. Hence the injected fetch layer.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/lib/store/memory.ts';
import { PoliteFetcher } from '../src/lib/fetch/polite.ts';
import { runCheck } from '../src/lib/check.ts';
import { normalize } from '../src/lib/snapshot/normalize.ts';
import { serializeSnapshot } from '../src/lib/snapshot/frontmatter.ts';

const URL_ = 'https://www.edb.gov.hk/tc/edu-system/primary-secondary/applicable-to-primary/whole-day-schooling/background/index.html';

const LIVE_HTML = `<div class="inner_page_content_container">
  <div class="generic_inner_page_paragraph_title"><h1 class="generic_inner_page_paragraph_title_h1">背景</h1></div>
  <div class="generic_page_content">
    <p>為加強基礎教育，本局於一九九三年開始逐步推行小學全日制。</p>
    <p>小學全日制實施以來，普遍得到社會人士特別是學校和家長的贊同和支持。</p>
  </div>
</div>`;

function setup() {
  const live = normalize(LIVE_HTML, URL_).body;
  // The reviewer's hand-edit: one sentence, in the committed snapshot only.
  const edited = live.replace('一九九三年', '二零零三年');
  expect(edited).not.toBe(live);

  const store = new MemoryStore({
    snapshots: {
      bg: serializeSnapshot({ url: URL_, title: '背景', fetched_at: '2026-09-01T00:00:00.000Z' }, edited),
    },
    // The last-known live representation, stored alongside its validators.
    cache: { bg: { html: LIVE_HTML, etag: 'W/"unchanged"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' } },
  });
  return { store, live, edited };
}

describe('HTTP 304 does not hide a snapshot edit', () => {
  it('detects the hand-edited sentence even though the server returns 304 with no body', async () => {
    const { store } = setup();
    // 304 responses legally carry no body. If the checker relied on the response body it
    // would see nothing here and wrongly conclude the page was unchanged.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch;

    const result = await runCheck({
      store,
      fetcher: new PoliteFetcher({ userAgent: 'test', delayMs: 0, fetchImpl }),
      pages: [{ slug: 'bg', url: URL_, title: '背景' }],
      robots: { disallow: [], fetched: true },
    });

    expect(result.status).toBe('changed');
    expect(result.changedPages).toBe(1);
    expect(result.changes[0]?.removed).toEqual(['為加強基礎教育，本局於二零零三年開始逐步推行小學全日制。']);
    expect(result.changes[0]?.added).toEqual(['為加強基礎教育，本局於一九九三年開始逐步推行小學全日制。']);

    // The conditional request really was made — this is the 304 path, not a plain 200.
    expect(fetchImpl).toHaveBeenCalled();
    const headers = (fetchImpl as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } }).mock.calls[0]?.[1]?.headers;
    expect(headers?.['If-None-Match']).toBe('W/"unchanged"');
  });

  it('refetches without conditional headers when a 304 arrives but the cache is unusable', async () => {
    const { store, live } = setup();
    await store.writeCache('bg', { html: '', etag: 'W/"unchanged"' });

    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // First call is conditional -> 304; the retry has no validators and gets the real body.
      return call === 1 ? new Response(null, { status: 304 }) : new Response(LIVE_HTML, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runCheck({
      store,
      fetcher: new PoliteFetcher({ userAgent: 'test', delayMs: 0, fetchImpl }),
      pages: [{ slug: 'bg', url: URL_, title: '背景' }],
      robots: { disallow: [], fetched: true },
    });

    expect(call).toBe(2);
    expect(result.status).toBe('changed');
    // The recovered baseline is the live text, not the edited one.
    expect((await store.readSnapshot('bg')) ?? '').toContain(live.split('\n')[0] ?? '');
  });
});
