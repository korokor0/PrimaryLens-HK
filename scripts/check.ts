/**
 * `pnpm check` — the daily comparison, for cron and for humans.
 *
 * This is NOT `pnpm crawl`. Crawl resets the baseline; check compares against it and must
 * never overwrite a snapshot before diffing (CLAUDE.md §5.2, §5.3).
 *
 *   pnpm check                          compare, notify, advance the baseline
 *   pnpm check -- --dry-run             compare and print; writes nothing, notifies nobody
 *   pnpm check -- --simulate "舊::新"    no EDB request at all; deterministic demo
 */
import { readFile } from 'node:fs/promises';
import { config as loadEnv } from 'dotenv';
import { ConfigError, parseConfig, parsePages } from '../src/lib/config.ts';
import { PoliteFetcher } from '../src/lib/fetch/polite.ts';
import { FsStore } from '../src/lib/store/fs.ts';
import { runCheck, type CheckOptions } from '../src/lib/check.ts';

loadEnv({ path: ['.env.local', '.env'], quiet: true });

function parseArgs(argv: string[]): CheckOptions {
  const options: CheckOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // pnpm forwards the `--` separator itself; §6 documents `pnpm check -- --dry-run`.
    if (arg === '--' || arg === undefined) continue;
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--simulate') {
      const value = argv[i + 1];
      if (value === undefined) throw new ConfigError('--simulate needs a value, e.g. --simulate "全日制::半日制"');
      const [from, to] = value.split('::');
      if (from === undefined || to === undefined || from === '') {
        throw new ConfigError(`--simulate expects "old::new" (got: ${value})`);
      }
      options.simulate = { from, to };
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new ConfigError(`unknown option: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cfg = parseConfig(process.env, 'monitor');
  const pages = parsePages(JSON.parse(await readFile('config/pages.json', 'utf8')));
  const store = new FsStore('data');
  const fetcher = new PoliteFetcher({ userAgent: cfg.botUserAgent, delayMs: cfg.fetchDelayMs });

  // --simulate must make no EDB request at all, robots.txt included.
  const robots =
    options.simulate !== undefined
      ? { disallow: [], fetched: false }
      : await fetcher.loadRobots(new URL(cfg.seedUrl).origin);

  if (options.simulate !== undefined) {
    console.log(`simulating "${options.simulate.from}" -> "${options.simulate.to}" (no network, no writes)`);
  } else if (options.dryRun) {
    console.log('dry run: comparing only; nothing will be written or notified');
  }

  const result = await runCheck(
    { store, fetcher, pages, robots, webhookUrl: cfg.webhookUrl, log: (line) => console.log(line) },
    options,
  );

  // Machine-readable summary line, as specified in §5.3.
  console.log(
    result.status === 'unchanged'
      ? 'status=unchanged'
      : `status=${result.status} pages=${result.changedPages} notified=${result.notified}`,
  );

  if (result.messages.length > 0) {
    console.log('');
    console.log(result.messages.join('\n\n---\n\n'));
  }

  // Exit 0 whenever the check completed, changed or not; exit 1 only for an actual failure.
  if (result.status === 'failed') {
    const failed = result.pages.filter((p) => p.status === 'failed');
    console.error(`\n${failed.length} page(s) could not be checked:`);
    for (const page of failed) console.error(`  ${page.slug}: ${page.note ?? 'unknown error'}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
