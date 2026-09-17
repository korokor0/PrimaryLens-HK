/**
 * Node entrypoint: load .env.local -> build an FsStore over ./data -> serve the Hono app.
 * Env reading lives here, never in src/lib (CLAUDE.md §4).
 */
import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { config as loadEnv } from 'dotenv';
import { createApp } from './app.ts';
import { parsePages } from './lib/config.ts';
import { FsStore } from './lib/store/fs.ts';

loadEnv({ path: ['.env.local', '.env'], quiet: true });

// Loopback only by default: the app has no authentication, so it must sit behind a reverse
// proxy rather than listen on every interface. Set HOST=0.0.0.0 only inside a container.
const hostname = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? 3666);
const pages = parsePages(JSON.parse(await readFile('config/pages.json', 'utf8')));
const app = createApp({ store: new FsStore('data'), env: process.env, pages });

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`EDB primary-education agent: http://${hostname}:${info.port}`);
});

// A busy port is the likeliest startup failure on someone else's machine; one readable
// line beats an unhandled EADDRINUSE stack trace (CLAUDE.md §4).
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Free it, or run: PORT=3667 pnpm start`);
    process.exit(1);
  }
  throw err;
});
