/**
 * Generic outgoing webhook (CLAUDE.md §2: one webhook via WEBHOOK_URL).
 *
 * The return value drives the baseline lifecycle, so it matters that a failure is reported
 * honestly rather than swallowed: when this returns false, runCheck keeps the old baseline so
 * the next run retries, which is what makes notification at-least-once (§5.3).
 */
import type { PageChange } from '../snapshot/diff.ts';

export interface WebhookPayload {
  title: string;
  url: string;
  heading: string;
  added: string[];
  removed: string[];
  message: string;
  checked_at: string;
}

export function buildPayload(change: PageChange, message: string, checkedAt: Date): WebhookPayload {
  return {
    title: change.title,
    url: change.url,
    heading: change.heading ?? '',
    added: change.added,
    removed: change.removed,
    message,
    checked_at: checkedAt.toISOString(),
  };
}

const TIMEOUT_MS = 10_000;

export interface NotifyResult {
  sent: boolean;
  detail: string;
}

export async function postWebhook(
  webhookUrl: string,
  payload: WebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok
      ? { sent: true, detail: `HTTP ${response.status}` }
      : { sent: false, detail: `webhook returned HTTP ${response.status}` };
  } catch (err) {
    return { sent: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
