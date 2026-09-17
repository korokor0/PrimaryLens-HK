/**
 * Turn a PageChange into the human-readable notification text (CLAUDE.md §5.4).
 *
 * Deterministic by design: no LLM is involved in monitoring. A change notification must say
 * the same thing every time it is produced, and must keep working when no API key is
 * configured at all (§4). §5.4 lists an LLM rewrite as an optional extra, never the
 * implementation.
 */
import type { PageChange } from '../snapshot/diff.ts';

/** Keep a notification readable when a page is rewritten wholesale. */
const MAX_LISTED = 3;

/** Hong Kong time, because that is where the readers are. */
export function formatHongKongTime(when: Date): string {
  const parts = new Intl.DateTimeFormat('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(when);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} HKT`;
}

function quoteList(sentences: string[]): string {
  const shown = sentences.slice(0, MAX_LISTED).map((sentence) => `「${sentence}」`);
  const extra = sentences.length - shown.length;
  return shown.join('\n') + (extra > 0 ? `\n（另有 ${extra} 項）` : '');
}

export function summarizeChange(change: PageChange, checkedAt: Date): string {
  const lines = ['📌 教育局「小學教育」頁面有更新', `頁面：${change.title}`];
  if (change.heading !== undefined) lines.push(`章節：${change.heading}`);
  lines.push('');

  // The common case — one sentence replaced by another — reads best as a before/after pair.
  if (change.removed.length === 1 && change.added.length === 1) {
    lines.push(`「${change.removed[0] ?? ''}」`, '改為', `「${change.added[0] ?? ''}」`);
  } else {
    if (change.removed.length > 0) lines.push(`刪除：`, quoteList(change.removed));
    if (change.added.length > 0) {
      if (change.removed.length > 0) lines.push('');
      lines.push(`新增：`, quoteList(change.added));
    }
  }

  lines.push('', `連結：${change.url}`, `檢查時間：${formatHongKongTime(checkedAt)}`);
  return lines.join('\n');
}
