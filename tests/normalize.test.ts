/**
 * Test 1 of §9: normalization keeps the real content and drops the chrome.
 *
 * This is the test that protects the snapshot from false positives. The live EDB header is
 * roughly 101KB and 638 navigation links; if any of it reached the snapshot, an unrelated menu
 * change anywhere on edb.gov.hk would fire a change notification.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/lib/snapshot/normalize.ts';

const URL_ = 'https://www.edb.gov.hk/tc/edu-system/primary-secondary/applicable-to-primary/small-class-teaching/index.html';

describe('normalize', () => {
  it('keeps main content, strips navigation/footer noise, and preserves structure', async () => {
    const html = await readFile(new URL('./fixtures/edb-page.html', import.meta.url), 'utf8');
    const { title, body } = normalize(html, URL_);

    expect(title).toBe('小班教學');

    // Real content survives.
    expect(body).toContain('本局透過安排不同形式的專業發展活動');
    expect(body).toContain('本局舉辦不同主題的研討會');

    // Chrome does not.
    for (const noise of ['網站地圖', '聯絡我們', '課程發展', '私隱政策', '免責聲明', '版權所有', '主頁 >']) {
      expect(body).not.toContain(noise);
    }
    // The revision date lives in an inline script and must never reach the body.
    expect(body).not.toContain('10/04/2026');

    // Standalone <strong> becomes a heading; bold leading a paragraph splits from its sentence.
    expect(body).toContain('## 相關活動');
    expect(body).toContain('## 研討會及經驗分享會');
    expect(body).not.toContain('相關活動本局透過');

    // List items keep their bullet; the h1 is not duplicated into the body (frontmatter has it).
    expect(body).toContain('- 參考資料');
    expect(body.startsWith('小班教學')).toBe(false);

    // A list item decorated with badge divs stays one bulleted line. Before this was fixed,
    // EDB's <div class="new-btn"><div>新</div></div> made the <li> look like scaffolding: it
    // lost its bullet and emitted 新 and PDF as if they were separate sentences.
    expect(body).toContain('- 第一部分：教育支援 (PDF) 新');
    expect(body.split('\n')).not.toContain('新');
    expect(body.split('\n')).not.toContain('PDF');

    // Inline links inside a sentence must not be split onto their own lines, or the diff would
    // report 「此處」 as a change in its own right. Only a block that *is* a list of links splits.
    expect(body).toContain('- 有關簡介會簡報，請點擊此處');
    expect(body.split('\n')).not.toContain('此處');

    // A line with no word character is punctuation, not content.
    expect(body.split('\n')).not.toContain('：');

    // Zero-width characters are stripped, so an invisible edit cannot change the hash.
    expect(body).toContain('每班學生人數為二十五人。');
    expect(body).not.toMatch(/[​-‍﻿]/);
  });
});
