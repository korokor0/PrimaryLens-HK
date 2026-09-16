/**
 * Turn a fetched EDB page into the stable markdown body that becomes its snapshot.
 *
 * The snapshot is the monitoring baseline *and* the thing a reviewer hand-edits, so this
 * output has two jobs: it must be readable enough to edit by hand, and stable enough that
 * re-fetching an unchanged page yields byte-identical text (CLAUDE.md §5.2, §5.3).
 *
 * Decisions taken from the live markup rather than assumed:
 *  - Content lives in `.inner_page_content_container`; `extract.ts` already isolates it, so
 *    navigation, breadcrumb and footer never reach this function.
 *  - EDB pages have no h2-h6. Section titles are `<strong>` standing alone in a block, so
 *    those are promoted to markdown headings — otherwise every page would be one flat wall
 *    of text with nothing for section-level diffs or section-aware chunking to hold onto.
 *  - Tables are layout, not data: a typical row is an empty first cell plus a text cell.
 *    Cells are therefore emitted as their own lines and empty cells dropped, instead of being
 *    rendered as a markdown table full of empty columns.
 *  - No volatile-string stripping. Verified on every sampled page: `最後更新` appears nowhere in
 *    visible content; EDB keeps the revision date in an inline script variable, outside the
 *    content container. Code to strip it would be dead code.
 */
import * as cheerio from 'cheerio';
// cheerio does not re-export its DOM node types, so they come from domhandler, which is
// cheerio's own dependency (version-matched). Type-only import: erased at runtime.
import type { AnyNode, Element } from 'domhandler';
import { extractPage } from '../fetch/extract.ts';

export interface NormalizedPage {
  title: string;
  body: string;
}

/** Elements that never contribute text. */
const DROP = new Set(['script', 'style', 'noscript', 'img', 'iframe', 'svg', 'button', 'input']);

/** Elements that start a new line in the output. */
const BLOCK = new Set([
  'p', 'div', 'li', 'td', 'th', 'tr', 'table', 'ul', 'ol', 'dl', 'dd', 'dt',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'blockquote', 'header', 'footer',
]);

/** A short `<strong>` alone in its block is a section title on this site. */
const MAX_PSEUDO_HEADING_CHARS = 60;

function isElement(node: AnyNode): node is Element {
  return node.type === 'tag';
}

function hasBlockChild($: cheerio.CheerioAPI, el: Element): boolean {
  return $(el).children().toArray().some((child) => BLOCK.has(child.tagName));
}

/** Collapse an element's inline content to one line, with <br> as a separator. */
function inlineText($: cheerio.CheerioAPI, el: Element): string {
  const parts: string[] = [];
  const walk = (node: AnyNode): void => {
    if (node.type === 'text') {
      parts.push(node.data);
      return;
    }
    if (!isElement(node)) return;
    if (DROP.has(node.tagName)) return;
    if (node.tagName === 'br') {
      parts.push('\n');
      return;
    }
    for (const child of node.children) walk(child);
  };
  for (const child of el.children) walk(child);
  return parts.join('');
}

/** NFC, no zero-width characters, no non-breaking spaces, single spaces. */
function clean(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** One emitted line, and whether it should become a markdown heading. */
interface Segment {
  text: string;
  heading: boolean;
}

/**
 * Split one leaf block into the lines it should produce.
 *
 * Two shapes on this site need splitting, and a naive `.text()` handles neither:
 *  - a section title and its paragraph share a block:
 *    `<p><strong>相關活動</strong>本局透過…</p>` must become a heading plus a paragraph.
 *  - several links share a block with no separator between them, so their text would
 *    otherwise concatenate into one unreadable run.
 *
 * A `<strong>` counts as a heading only when it *starts* a line. Bold used for emphasis
 * mid-sentence stays part of the sentence, which is what keeps sentence-level diffs intact.
 */
function segmentBlock($: cheerio.CheerioAPI, el: Element): Segment[] {
  const out: Segment[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    const text = clean(buffer.join(''));
    if (text !== '') out.push({ text, heading: false });
    buffer = [];
  };
  /**
   * A <strong> begins a heading when nothing precedes it on this line, or when what does
   * precede it is a finished sentence. Bold in the middle of a sentence is emphasis and
   * must stay inline, or sentence-level diffs would fragment.
   */
  const canStartHeading = (): boolean => {
    const pending = clean(buffer.join(''));
    return pending === '' || /[。！？；]$/.test(pending);
  };

  const anchorCount = $(el).find('a').length;

  const walk = (node: AnyNode): void => {
    if (node.type === 'text') {
      buffer.push(node.data);
      return;
    }
    if (!isElement(node)) return;
    if (DROP.has(node.tagName)) return;

    if (node.tagName === 'br') {
      flush();
      return;
    }

    if (node.tagName === 'strong' || node.tagName === 'b') {
      const text = clean($(node).text());
      if (text !== '' && text.length <= MAX_PSEUDO_HEADING_CHARS && canStartHeading()) {
        flush();
        out.push({ text, heading: true });
        return;
      }
    }

    // Only break links apart when the block is a list of them; a single inline link
    // belongs in its sentence.
    if (node.tagName === 'a' && anchorCount >= 2) {
      const text = clean($(node).text());
      if (text !== '') {
        flush();
        out.push({ text, heading: false });
        return;
      }
    }

    for (const child of node.children) walk(child);
  };

  for (const child of el.children) walk(child);
  flush();
  return out;
}

export function htmlToMarkdown(contentHtml: string): string {
  // Fragment mode (third argument `false`): without it cheerio wraps the content in
  // <html><body>, and the walker would flatten the whole page into a single line.
  const $ = cheerio.load(contentHtml, null, false);
  const lines: string[] = [];

  const emit = (line: string): void => {
    if (line !== '') lines.push(line);
  };

  const walk = (el: Element): void => {
    if (DROP.has(el.tagName)) return;

    const heading = /^h([1-6])$/.exec(el.tagName);
    if (heading?.[1] !== undefined) {
      // h1 is the page title, which frontmatter already carries; keep deeper levels only.
      const level = Number(heading[1]);
      if (level > 1) emit(`${'#'.repeat(level)} ${clean($(el).text())}`);
      return;
    }

    // A block with block children is scaffolding: descend rather than flatten it.
    if (BLOCK.has(el.tagName) && hasBlockChild($, el)) {
      for (const child of el.children) if (isElement(child)) walk(child);
      return;
    }

    if (BLOCK.has(el.tagName)) {
      for (const segment of segmentBlock($, el)) {
        if (segment.heading) emit(`## ${segment.text}`);
        else if (el.tagName === 'li') emit(`- ${segment.text}`);
        else emit(segment.text);
      }
      return;
    }

    // Inline element sitting outside any block (EDB does this at the top of some pages).
    for (const segment of segmentBlock($, el)) {
      if (segment.heading) emit(`## ${segment.text}`);
      else emit(segment.text);
    }
  };

  for (const node of $.root().children().toArray()) {
    if (isElement(node)) walk(node);
  }

  // One blank line before each heading keeps the markdown readable for hand-editing.
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('#') && out.length > 0) out.push('');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function normalize(html: string, pageUrl: string): NormalizedPage {
  const page = extractPage(html, pageUrl);
  return { title: clean(page.title), body: htmlToMarkdown(page.contentHtml) };
}
