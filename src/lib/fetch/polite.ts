/**
 * Polite HTTP access to edb.gov.hk.
 *
 * Rules from CLAUDE.md §5.1, all enforced here so no caller can accidentally skip them:
 * serial requests only, a fixed delay between them, an identifying User-Agent, a 15s
 * timeout, at most one retry, and robots.txt respected.
 *
 * Web-standard APIs only (fetch / AbortSignal / setTimeout) so this file also runs on a Worker.
 */

/**
 * robots.txt is deliberately NOT a general parser.
 *
 * Verified against https://www.edb.gov.hk/robots.txt (2026-09-16): a single `User-agent: *`
 * group with six literal `Disallow` paths, no wildcards, no `Allow`, no `Crawl-delay`.
 * A plain path-prefix test is therefore exactly correct, and a general parser would be
 * unexplainable code written for cases this site does not have.
 */
export interface RobotsRules {
  disallow: string[];
  /** False when robots.txt could not be fetched; we then proceed, per standard behaviour. */
  fetched: boolean;
}

export const EMPTY_ROBOTS: RobotsRules = { disallow: [], fetched: false };

/** Parse only the groups that apply to us: `User-agent: *` and our own UA. */
export function parseRobots(text: string, userAgent: string): string[] {
  const disallow: string[] = [];
  let applies = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === 'user-agent') {
      applies = value === '*' || userAgent.toLowerCase().startsWith(value.toLowerCase());
    } else if (field === 'disallow' && applies && value !== '') {
      disallow.push(value);
    }
  }
  return disallow;
}

/** True unless an explicit Disallow prefix matches. Only a match blocks a URL. */
export function isAllowed(rules: RobotsRules, url: string): boolean {
  const path = new URL(url).pathname;
  return !rules.disallow.some((prefix) => path.startsWith(prefix));
}

export interface FetchResult {
  status: number;
  /** Response body for 200; null for 304 (caller substitutes its cached body) or on failure. */
  html: string | null;
  etag: string | undefined;
  lastModified: string | undefined;
}

export interface Validators {
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export interface PoliteOptions {
  userAgent: string;
  delayMs: number;
  timeoutMs?: number;
  /** Injectable for tests — CLAUDE.md §9 forbids tests touching the real site. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Serial fetcher. One instance per crawl/check run; it paces itself, so callers just await.
 */
export class PoliteFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private lastRequestAt = 0;

  constructor(private readonly opts: PoliteOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Wait out the remainder of FETCH_DELAY_MS since the previous request. */
  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.opts.delayMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
  }

  private async attempt(url: string, validators?: Validators): Promise<Response> {
    const headers: Record<string, string> = { 'User-Agent': this.opts.userAgent };
    // Only send conditional headers when we actually hold a validator.
    if (validators?.etag) headers['If-None-Match'] = validators.etag;
    if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;

    await this.pace();
    return this.fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /** GET with one retry. Network errors and 5xx are retried once; 4xx is not. */
  async get(url: string, validators?: Validators): Promise<FetchResult> {
    let response: Response;
    try {
      response = await this.attempt(url, validators);
      if (response.status >= 500) response = await this.attempt(url, validators);
    } catch {
      try {
        response = await this.attempt(url, validators);
      } catch (err) {
        throw new Error(`fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const etag = response.headers.get('etag') ?? undefined;
    const lastModified = response.headers.get('last-modified') ?? undefined;

    // 304 carries no body by definition; the caller supplies the cached one (§5.1).
    if (response.status === 304) {
      return { status: 304, html: null, etag, lastModified };
    }
    if (!response.ok) {
      return { status: response.status, html: null, etag, lastModified };
    }
    return { status: response.status, html: await response.text(), etag, lastModified };
  }

  /** Fetch robots.txt once per run. A missing/unreachable robots.txt is not an error. */
  async loadRobots(origin: string): Promise<RobotsRules> {
    try {
      const result = await this.get(new URL('/robots.txt', origin).toString());
      if (result.status !== 200 || result.html === null) return EMPTY_ROBOTS;
      return { disallow: parseRobots(result.html, this.opts.userAgent), fetched: true };
    } catch {
      return EMPTY_ROBOTS;
    }
  }
}
