/**
 * /status — an operational view of the monitor. Server-rendered with hono/jsx, no JavaScript.
 *
 * CLAUDE.md §7 asks for one page; this second one was added on request. It shows nothing that
 * /api/status and the files under data/ do not already contain — it puts them where a person
 * can read them at a glance: is chat configured, is a webhook set, when did the last check
 * run and what did it find, how old is each snapshot. It never renders the API key.
 */
import type { LastCheck } from '../lib/store/types.ts';
import { formatHongKongTime } from '../lib/notify/summarize.ts';
import { STYLES } from './page.tsx';

export interface StatusPageRow {
  slug: string;
  title: string;
  url: string;
  hasSnapshot: boolean;
  fetchedAt?: string | undefined;
  status?: string | undefined;
  note?: string | undefined;
}

export interface StatusView {
  startedAt: Date;
  now: Date;
  chat: { configured: boolean; model?: string | undefined; baseUrl?: string | undefined; error?: string | undefined };
  monitor: { webhookConfigured: boolean; fetchDelayMs?: number | undefined; error?: string | undefined };
  index: { builtAt: string; chunkCount: number } | null;
  lastCheck: LastCheck | null;
  rows: StatusPageRow[];
}

/** Auto-refresh interval, in seconds. Zero JavaScript is the point of this page. */
const REFRESH_SECONDS = 30;

const STATUS_STYLES = `
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; font-size: 14px; }
dt { color: var(--muted); }
dd { margin: 0; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
td a { color: var(--accent); text-decoration: none; }
.pill-skipped { color: var(--warn); }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--err); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } }
`;

const hkt = (iso: string | undefined): string => {
  if (iso === undefined) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatHongKongTime(d);
};

const uptime = (from: Date, to: Date): string => {
  const total = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} 小時 ${m} 分` : `${m} 分 ${total % 60} 秒`;
};

function StatusPage({ view }: { view: StatusView }) {
  const { chat, monitor, index, lastCheck, rows } = view;
  const withSnapshot = rows.filter((r) => r.hasSnapshot).length;

  return (
    <html lang="zh-Hant-HK">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta http-equiv="refresh" content={String(REFRESH_SECONDS)} />
        <title>狀態 · 教育局「小學教育」監察 Agent</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES + STATUS_STYLES }} />
      </head>
      <body>
        <div class="wrap">
          <header>
            <h1>系統狀態</h1>
            <p>
              <a href="/">← 返回主頁</a> · 每 {REFRESH_SECONDS} 秒自動更新 · 產生於 {formatHongKongTime(view.now)}
            </p>
          </header>

          <div class="grid2">
            <section class="panel">
              <h2>服務</h2>
              <dl>
                <dt>啟動時間</dt><dd>{formatHongKongTime(view.startedAt)}</dd>
                <dt>已運行</dt><dd>{uptime(view.startedAt, view.now)}</dd>
                <dt>監察頁面</dt><dd>{rows.length} 頁（{withSnapshot} 頁已有快照）</dd>
              </dl>
            </section>

            <section class="panel">
              <h2>設定</h2>
              <dl>
                <dt>問答（LLM）</dt>
                <dd>
                  {chat.configured
                    ? <span class="ok">已設定 · {chat.model} · {chat.baseUrl}</span>
                    : <span class="warn">未設定 — {chat.error ?? '缺少 OPENAI_API_KEY / OPENAI_MODEL'}</span>}
                </dd>
                <dt>Webhook</dt>
                <dd>{monitor.webhookConfigured ? <span class="ok">已設定</span> : <span class="warn">未設定 — 檢查仍會執行，只是不會發送通知</span>}</dd>
                <dt>抓取間隔</dt><dd>{monitor.error ?? `${monitor.fetchDelayMs ?? '—'} ms`}</dd>
              </dl>
            </section>

            <section class="panel">
              <h2>檢索索引</h2>
              {index
                ? <dl><dt>建立時間</dt><dd>{hkt(index.builtAt)}</dd><dt>段落數</dt><dd>{index.chunkCount}</dd></dl>
                : <p class="warn">尚未建立 — 請先執行 <code>pnpm crawl</code>。在此之前問答功能無法運作。</p>}
            </section>

            <section class="panel">
              <h2>上次檢查</h2>
              {lastCheck
                ? (
                  <dl>
                    <dt>時間</dt><dd>{hkt(lastCheck.checkedAt)}</dd>
                    <dt>結果</dt><dd><span class={`pill pill-${lastCheck.status}`}>{lastCheck.status}</span></dd>
                    <dt>變更頁數</dt><dd>{lastCheck.changedPages}</dd>
                    <dt>已通知</dt><dd>{lastCheck.notified ? '是' : '否'}</dd>
                  </dl>
                )
                : <p class="muted">尚未檢查。執行 <code>pnpm check</code>，或在主頁按「檢查更新」。</p>}
            </section>
          </div>

          <section class="panel monitor">
            <h2>監察頁面</h2>
            <div style="overflow-x:auto">
              <table>
                <thead>
                  <tr><th>頁面</th><th>快照時間</th><th>上次檢查</th><th>備註</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr>
                      <td><a href={r.url} target="_blank" rel="noreferrer">{r.title}</a><br /><span class="muted mono">{r.slug}</span></td>
                      <td>{r.hasSnapshot ? hkt(r.fetchedAt) : <span class="bad">無快照</span>}</td>
                      <td>{r.status ? <span class={`pill pill-${r.status}`}>{r.status}</span> : <span class="muted">—</span>}</td>
                      <td class="muted">{r.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <footer>此頁只讀，不會觸發任何抓取或檢查。</footer>
        </div>
      </body>
    </html>
  );
}

export function renderStatusPage(view: StatusView): string {
  return `<!doctype html>${StatusPage({ view }).toString()}`;
}
