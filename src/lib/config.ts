/**
 * Configuration parsing — hand-rolled on purpose (no schema library).
 *
 * Two rules from CLAUDE.md §2/§4 shape this file:
 *  1. `src/lib` never reads `process.env`. The caller passes an env bag in, so the same
 *     code works with Node's `process.env` locally or a Worker's `env` binding later.
 *  2. Config is validated per *capability*. Monitoring must keep working with no LLM
 *     credentials at all, because change detection is deterministic and must not
 *     depend on the model.
 */

export type Need = 'chat' | 'monitor';

export interface Config {
  openaiApiKey: string | undefined;
  openaiBaseUrl: string;
  openaiModel: string | undefined;
  /**
   * Optional cheaper model for the first call only — choosing search terms is a trivial task.
   * The grounded answer always uses `openaiModel`. Unset means both calls use the same model.
   */
  openaiQueryModel: string | undefined;
  webhookUrl: string | undefined;
  seedUrl: string;
  fetchDelayMs: number;
  botUserAgent: string;
}

/** Thrown for bad/missing config. Entrypoints print `err.message` alone — never a stack. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULTS = {
  openaiBaseUrl: 'https://api.openai.com/v1',
  seedUrl: 'https://www.edb.gov.hk/tc/edu-system/primary-secondary/primary.html',
  fetchDelayMs: 1500,
  botUserAgent: 'edb-primary-agent/0.1 (+contact)',
} as const;

/** Treat whitespace-only values as absent, so a blank line in .env.local is not a value. */
function read(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function requireUrl(value: string, key: string): string {
  try {
    new URL(value);
    return value;
  } catch {
    throw new ConfigError(`${key} is not a valid URL: ${value}`);
  }
}

function positiveInt(value: string | undefined, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`${key} must be a non-negative integer (got: ${value})`);
  }
  return n;
}

/**
 * Parse and validate config for one capability.
 *
 * `need: 'chat'` additionally requires OPENAI_API_KEY and OPENAI_MODEL.
 * `need: 'monitor'` (discover/crawl/check) requires neither.
 */
export function parseConfig(env: Record<string, string | undefined>, need: Need): Config {
  const openaiApiKey = read(env, 'OPENAI_API_KEY');
  const openaiModel = read(env, 'OPENAI_MODEL');

  if (need === 'chat') {
    const missing = [
      openaiApiKey ? null : 'OPENAI_API_KEY',
      openaiModel ? null : 'OPENAI_MODEL',
    ].filter((k): k is string => k !== null);

    if (missing.length > 0) {
      throw new ConfigError(
        `Chat needs ${missing.join(' and ')}. Set ${missing.length > 1 ? 'them' : 'it'} in .env.local ` +
          `(copy .env.example). Monitoring commands (discover/crawl/check) work without this.`,
      );
    }
  }

  const webhookUrl = read(env, 'WEBHOOK_URL');

  return {
    openaiApiKey,
    openaiModel,
    openaiQueryModel: read(env, 'OPENAI_QUERY_MODEL'),
    openaiBaseUrl: requireUrl(read(env, 'OPENAI_BASE_URL') ?? DEFAULTS.openaiBaseUrl, 'OPENAI_BASE_URL'),
    webhookUrl: webhookUrl ? requireUrl(webhookUrl, 'WEBHOOK_URL') : undefined,
    seedUrl: requireUrl(read(env, 'EDB_SEED_URL') ?? DEFAULTS.seedUrl, 'EDB_SEED_URL'),
    fetchDelayMs: positiveInt(read(env, 'FETCH_DELAY_MS'), 'FETCH_DELAY_MS', DEFAULTS.fetchDelayMs),
    botUserAgent: read(env, 'BOT_USER_AGENT') ?? DEFAULTS.botUserAgent,
  };
}

/** One entry of the reviewed allowlist in config/pages.json. */
export interface WatchedPage {
  slug: string;
  url: string;
  title: string;
  /** The hub this page was reached from, or 'seed'. Used to name topics for the §5.7 message. */
  discoveredFrom?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate config/pages.json. Hand-rolled to match parseConfig: the file is human-edited
 * (CLAUDE.md §5.1 step 7), so a typo must produce one readable line, not a crash deep inside
 * the crawl. Only `pages` is read; `candidates` is review material, deliberately ignored.
 */
export function parsePages(raw: unknown): WatchedPage[] {
  if (!isRecord(raw) || !Array.isArray(raw['pages'])) {
    throw new ConfigError('config/pages.json: expected an object with a "pages" array. Run `pnpm discover` first.');
  }

  const pages: WatchedPage[] = [];
  const seen = new Set<string>();

  raw['pages'].forEach((entry: unknown, index: number) => {
    const where = `config/pages.json: pages[${index}]`;
    if (!isRecord(entry)) throw new ConfigError(`${where} is not an object.`);

    const { slug, url, title } = entry;
    if (typeof slug !== 'string' || slug === '') throw new ConfigError(`${where} is missing a "slug".`);
    if (typeof url !== 'string' || url === '') throw new ConfigError(`${where} (${slug}) is missing a "url".`);
    if (typeof title !== 'string') throw new ConfigError(`${where} (${slug}) is missing a "title".`);
    if (seen.has(slug)) throw new ConfigError(`${where}: duplicate slug "${slug}"; slugs become filenames and must be unique.`);

    try {
      new URL(url);
    } catch {
      throw new ConfigError(`${where} (${slug}) has an invalid url: ${url}`);
    }

    const from = entry['discoveredFrom'];
    seen.add(slug);
    pages.push({ slug, url, title, ...(typeof from === 'string' ? { discoveredFrom: from } : {}) });
  });

  if (pages.length === 0) throw new ConfigError('config/pages.json lists no pages. Run `pnpm discover` first.');
  return pages;
}

/**
 * Topic names for the not-found message (§5.7 asks that these come from the reviewed
 * allowlist rather than being invented).
 *
 * Hub names are used, not page titles: the pages themselves are titled things like 背景,
 * 一般資料 and 參考資料, which would make useless suggestions. The hub a page was discovered
 * through — 小班教學, 直接資助計劃 — is the name a parent or teacher would actually ask about.
 */
export function exampleTopics(pages: WatchedPage[], limit = 4): string[] {
  const topics: string[] = [];
  const add = (name: string): void => {
    if (name !== '' && name !== 'seed' && !topics.includes(name)) topics.push(name);
  };

  for (const page of pages) add(page.discoveredFrom ?? '');
  // Top up from pages reached straight off the seed, which are titled by their own topic.
  for (const page of pages) if (page.discoveredFrom === 'seed') add(page.title);

  return topics.slice(0, limit);
}
