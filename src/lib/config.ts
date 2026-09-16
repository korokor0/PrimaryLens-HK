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
    openaiBaseUrl: requireUrl(read(env, 'OPENAI_BASE_URL') ?? DEFAULTS.openaiBaseUrl, 'OPENAI_BASE_URL'),
    webhookUrl: webhookUrl ? requireUrl(webhookUrl, 'WEBHOOK_URL') : undefined,
    seedUrl: requireUrl(read(env, 'EDB_SEED_URL') ?? DEFAULTS.seedUrl, 'EDB_SEED_URL'),
    fetchDelayMs: positiveInt(read(env, 'FETCH_DELAY_MS'), 'FETCH_DELAY_MS', DEFAULTS.fetchDelayMs),
    botUserAgent: read(env, 'BOT_USER_AGENT') ?? DEFAULTS.botUserAgent,
  };
}
