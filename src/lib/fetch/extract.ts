/**
 * Pull the meaningful part out of an EDB page.
 *
 * Selectors were derived by inspecting the live markup (2026-09-16), not guessed:
 *  - every page wraps its real content in `.inner_page_content_container`
 *  - the page heading is `h1.generic_inner_page_paragraph_title_h1`
 *  - everything else (a ~101KB, 638-link navigation `<header>`) is chrome
 *
 * Working from that one container is what keeps navigation noise out of snapshots, so a
 * menu change elsewhere on edb.gov.hk never looks like a content change (CLAUDE.md §5.2).
 */
import * as cheerio from 'cheerio';

export interface ExtractedPage {
  title: string;
  /** Inner HTML of the content container; normalize.ts turns this into snapshot markdown. */
  contentHtml: string;
  /** Flattened text, used for the hub heuristic and for sanity-checking a page is worth keeping. */
  contentText: string;
  /** Absolute, deduplicated hrefs found inside the content container only. */
  links: string[];
}

const CONTENT_SELECTOR = '.inner_page_content_container';
const HEADING_SELECTOR = '.generic_inner_page_paragraph_title_h1';
/** EDB titles all end in this suffix; the h1 is preferred, this is the fallback. */
const TITLE_SUFFIX = / - 教育局\s*$/;

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const container = $(CONTENT_SELECTOR).first();

  const h1 = container.find(HEADING_SELECTOR).first().text().trim();
  const title = h1 !== '' ? h1 : $('title').first().text().replace(TITLE_SUFFIX, '').trim();

  const links: string[] = [];
  const seen = new Set<string>();
  container.find('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href === undefined) return;
    const absolute = toAbsolute(href, pageUrl);
    if (absolute !== null && !seen.has(absolute)) {
      seen.add(absolute);
      links.push(absolute);
    }
  });

  return {
    title,
    contentHtml: container.html() ?? '',
    contentText: container.text().replace(/\s+/g, ' ').trim(),
    links,
  };
}

/**
 * Resolve an href against the page URL, dropping the fragment and forcing https.
 * EDB mixes relative hrefs with absolute `http://www.edb.gov.hk/...` ones, and the two
 * spellings of the same page must not become two entries in the allowlist.
 */
export function toAbsolute(href: string, pageUrl: string): string | null {
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A "hub" is a page whose content is a list of links rather than prose — the seed itself,
 * and several topic landing pages. Discovery follows a hub's children one level further so
 * the corpus ends up holding real text (see docs/AI_LOG.md for the measurements behind this).
 *
 * Observed on the live site: hubs measured 25-187 content chars, genuine content pages 508-2159.
 * 400 sits in that gap with room on both sides.
 */
export const HUB_MAX_CONTENT_CHARS = 400;

export function isHubPage(page: ExtractedPage): boolean {
  return page.contentText.length < HUB_MAX_CONTENT_CHARS && page.links.length >= 2;
}
