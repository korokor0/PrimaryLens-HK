/**
 * Node entrypoint: load .env.local -> build an FsStore over ./data -> serve the Hono app.
 * Env reading lives here, never in src/lib (CLAUDE.md §4).
 */
import { serve } from '@hono/node-server';
import { config as loadEnv } from 'dotenv';
import { createApp } from './app.ts';
import { FsStore } from './lib/store/fs.ts';

loadEnv({ path: ['.env.local', '.env'], quiet: true });

const port = Number(process.env['PORT'] ?? 3000);
const app = createApp({ store: new FsStore('data'), env: process.env });

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`EDB primary-education agent: http://localhost:${info.port}`);
});

// A busy port is the likeliest startup failure on someone else's machine; one readable
// line beats an unhandled EADDRINUSE stack trace (CLAUDE.md §4).
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Free it, or run: PORT=3001 pnpm start`);
    process.exit(1);
  }
  throw err;
});
