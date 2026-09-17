/**
 * The single page (CLAUDE.md §7), rendered with hono/jsx.
 *
 * One inline <script> of plain browser JS: no framework, no bundler, no CDN. §7 says not to
 * spend time on polish, so this is a plain two-column layout that collapses on a phone.
 *
 * The activity panel renders the same structured trace that /api/chat returns and that is
 * appended to data/trace/*.jsonl — tool names, arguments, scores and timings, never reasoning.
 * The client script writes every page-derived value with textContent rather than innerHTML.
 */

const CLIENT_JS = `/* Plain browser JS. No framework, no build step, no CDN (CLAUDE.md §2, §7).
   Everything user- or page-derived is written with textContent, never innerHTML. */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ---------- Agent activity panel: the structured trace, never reasoning ---------- */
  function renderTrace(trace) {
    var panel = $('activity');
    clear(panel);
    if (!trace) { panel.appendChild(el('p', 'muted', '未有活動記錄。')); return; }

    var head = el('div', 'trace-head');
    head.appendChild(el('span', 'pill pill-' + trace.outcome, trace.outcome));
    head.appendChild(el('span', 'muted', trace.totalMs + ' ms'));
    panel.appendChild(head);

    trace.steps.forEach(function (step) {
      var row = el('div', 'step');
      if (step.type === 'model_call') {
        row.appendChild(el('div', 'step-title', 'model_call · ' + step.stage));
        row.appendChild(el('div', 'step-body', step.model + ' · tool_choice=' + step.toolChoice + ' · ' + step.ms + ' ms'));
      } else if (step.type === 'tool_call') {
        row.appendChild(el('div', 'step-title', 'tool_call · ' + step.name));
        row.appendChild(el('div', 'step-body mono', 'query: ' + step.arguments.query));
      } else if (step.type === 'tool_result') {
        row.appendChild(el('div', 'step-title', 'tool_result · ' + step.hits + ' hit(s)'));
        row.appendChild(el('div', 'step-body', 'top score ' + step.topScore + ' · threshold ' + step.threshold + ' · ' + (step.passed ? '通過' : '低於門檻') + ' · ' + step.ms + ' ms'));
        step.sources.forEach(function (s) {
          var item = el('div', 'source');
          item.appendChild(el('span', 'score', s.score.toFixed(3)));
          item.appendChild(el('span', 'source-title', s.title + (s.heading ? ' › ' + s.heading : '')));
          row.appendChild(item);
        });
      } else if (step.type === 'guardrail') {
        row.className = 'step step-guard';
        row.appendChild(el('div', 'step-title', 'guardrail · ' + step.rule));
        row.appendChild(el('div', 'step-body', step.detail));
      }
      panel.appendChild(row);
    });
  }

  /* ---------- Chat ---------- */
  function addMessage(role, text) {
    var wrap = el('div', 'msg msg-' + role);
    wrap.appendChild(el('div', 'msg-role', role === 'user' ? '你' : '助理'));
    wrap.appendChild(el('div', 'msg-text', text));
    $('messages').appendChild(wrap);
    $('messages').scrollTop = $('messages').scrollHeight;
    return wrap;
  }

  function addCitations(wrap, sources) {
    if (!sources || !sources.length) return;
    var seen = {};
    var list = el('div', 'cites');
    sources.forEach(function (s) {
      if (seen[s.url]) return;
      seen[s.url] = 1;
      var a = el('a', 'cite', s.title);
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      list.appendChild(a);
    });
    wrap.appendChild(list);
  }

  function ask() {
    var input = $('question');
    var text = input.value.trim();
    if (!text) return;
    addMessage('user', text);
    input.value = '';
    $('send').disabled = true;

    var pending = addMessage('assistant', '查詢中…');

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var body = pending.querySelector('.msg-text');
        if (data.error) { body.textContent = data.error; pending.className = 'msg msg-assistant msg-error'; return; }
        body.textContent = data.answer;
        if (!data.grounded) pending.className = 'msg msg-assistant msg-nogrounding';
        addCitations(pending, data.grounded ? data.sources : null);
        renderTrace(data.trace);
      })
      .catch(function (err) {
        pending.querySelector('.msg-text').textContent = '請求失敗：' + err.message;
        pending.className = 'msg msg-assistant msg-error';
      })
      .then(function () { $('send').disabled = false; input.focus(); });
  }

  /* ---------- Source monitor ---------- */
  function renderStatus(data) {
    var last = data && data.lastCheck;
    $('watched').textContent = data && data.watchedPages != null ? data.watchedPages : '–';
    if (!last) { $('lastcheck').textContent = '尚未檢查'; return; }
    $('lastcheck').textContent = new Date(last.checkedAt).toLocaleString('zh-HK', { hourCycle: 'h23' }) +
      ' · ' + last.status + ' · 變更 ' + last.changedPages + ' 頁';
  }

  function runCheck() {
    var btn = $('check');
    btn.disabled = true;
    btn.textContent = '檢查中…';
    var out = $('checkout');
    clear(out);
    out.appendChild(el('p', 'muted', '正在比對監察中的頁面…'));

    fetch('/api/check', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        clear(out);
        if (data.error) { out.appendChild(el('p', 'error', data.error)); return; }

        var head = el('div', 'trace-head');
        head.appendChild(el('span', 'pill pill-' + data.status, 'status=' + data.status));
        head.appendChild(el('span', 'muted', '變更 ' + data.changedPages + ' 頁 · 已通知 ' + (data.notified ? '是' : '否')));
        out.appendChild(head);

        if (!data.webhookConfigured) out.appendChild(el('p', 'muted', '通知已略過：未設定 WEBHOOK_URL'));
        if (data.messages && data.messages.length) {
          data.messages.forEach(function (m) { out.appendChild(el('pre', 'diff', m)); });
        } else if (data.status === 'unchanged') {
          out.appendChild(el('p', 'muted', '所有監察頁面均無變更。'));
        }
        return fetch('/api/status').then(function (r) { return r.json(); }).then(renderStatus);
      })
      .catch(function (err) { clear(out); out.appendChild(el('p', 'error', '檢查失敗：' + err.message)); })
      .then(function () { btn.disabled = false; btn.textContent = '檢查更新'; });
  }

  /* ---------- wiring ---------- */
  $('send').addEventListener('click', ask);
  $('question').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  $('check').addEventListener('click', runCheck);
  document.querySelectorAll('.example').forEach(function (btn) {
    btn.addEventListener('click', function () { $('question').value = btn.textContent; $('question').focus(); });
  });

  fetch('/api/status').then(function (r) { return r.json(); }).then(renderStatus).catch(function () {});
})();
`;

const STYLES = `
:root {
  --bg: #f6f7f9; --panel: #fff; --ink: #14181f; --muted: #626b7a; --line: #e2e6ec;
  --accent: #1d4ed8; --ok: #0f7b4f; --warn: #a15c00; --err: #b3261e; --code: #f1f3f7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #11141a; --panel: #171b23; --ink: #e8ebf0; --muted: #98a2b3; --line: #262c37;
    --accent: #7ea2ff; --ok: #4ade80; --warn: #fbbf24; --err: #f87171; --code: #1e242e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang HK", "Microsoft JhengHei", sans-serif;
}
.wrap { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; }
header h1 { font-size: 20px; margin: 0 0 2px; }
header p { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
.grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
.panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 12px; }
#messages { min-height: 220px; max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.msg-role { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
.msg-text { white-space: pre-wrap; word-break: break-word; }
.msg-user .msg-text { background: var(--code); border-radius: 8px; padding: 8px 10px; }
.msg-nogrounding .msg-text { color: var(--warn); }
.msg-error .msg-text { color: var(--err); }
.cites { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.cite { font-size: 12px; color: var(--accent); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; text-decoration: none; }
.ask { display: flex; gap: 8px; margin-top: 14px; }
textarea {
  flex: 1; resize: vertical; min-height: 44px; font: inherit; color: inherit;
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px;
}
button {
  font: inherit; cursor: pointer; border-radius: 8px; border: 1px solid transparent;
  background: var(--accent); color: #fff; padding: 10px 16px;
}
button:disabled { opacity: .55; cursor: default; }
.examples { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.example { background: transparent; color: var(--muted); border-color: var(--line); font-size: 12px; padding: 3px 10px; }
.step { border-left: 2px solid var(--line); padding: 4px 0 4px 10px; margin-bottom: 10px; }
.step-guard { border-left-color: var(--warn); }
.step-title { font-size: 12px; font-weight: 600; }
.step-body { font-size: 12px; color: var(--muted); }
.mono, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.source { display: flex; gap: 8px; font-size: 12px; color: var(--muted); margin-top: 3px; }
.score { font-family: ui-monospace, monospace; color: var(--accent); }
.source-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trace-head { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.pill { font-size: 11px; border-radius: 999px; padding: 2px 9px; background: var(--code); }
.pill-answered, .pill-changed { color: var(--ok); }
.pill-no_evidence, .pill-rejected, .pill-unchanged { color: var(--muted); }
.pill-error, .pill-failed { color: var(--err); }
.muted { color: var(--muted); font-size: 13px; }
.error { color: var(--err); font-size: 13px; }
.monitor { margin-top: 16px; }
.monitor-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.diff { background: var(--code); border-radius: 8px; padding: 12px; font-size: 13px; white-space: pre-wrap; overflow-x: auto; }
footer { margin-top: 24px; color: var(--muted); font-size: 12px; }
`;

const EXAMPLES = [
  '小學全日制的背景是甚麼？',
  '直資學校的學費減免',
  '香港今日天氣點樣？',
];

function Page() {
  return (
    <html lang="zh-Hant-HK">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>教育局「小學教育」監察 Agent</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <div class="wrap">
          <header>
            <h1>教育局「小學教育」監察 Agent</h1>
            <p>只根據監察中的教育局頁面作答，並偵測頁面內容變更。</p>
          </header>

          <div class="grid">
            <section class="panel">
              <h2>問答</h2>
              <div id="messages" />
              <div class="ask">
                <textarea id="question" rows={1} maxlength={1000} placeholder="例如：小學全日制的背景是甚麼？" />
                <button id="send">發送</button>
              </div>
              <div class="examples">
                {EXAMPLES.map((text) => (
                  <button class="example">{text}</button>
                ))}
              </div>
            </section>

            <section class="panel">
              <h2>Agent 活動</h2>
              <div id="activity">
                <p class="muted">提出問題後，這裡會顯示工具呼叫、檢索分數和時間。</p>
              </div>
            </section>
          </div>

          <section class="panel monitor">
            <div class="monitor-head">
              <div>
                <h2>來源監察</h2>
                <p class="muted">
                  監察頁面：<span id="watched">–</span> · 上次檢查：<span id="lastcheck">載入中…</span>
                </p>
              </div>
              <button id="check">檢查更新</button>
            </div>
            <div id="checkout" />
          </section>

          <footer>資料來源：香港教育局 edb.gov.hk。本頁只供示範用途。</footer>
        </div>
        <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
      </body>
    </html>
  );
}

export function renderPage(): string {
  return `<!doctype html>${Page().toString()}`;
}
