#!/usr/bin/env node
import { Command } from 'commander';
import { runAuth } from './auth.js';
import { runCycle, runDaemon } from './daemon.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { createLogger } from './logger.js';
import { runSync } from './sync.js';

const program = new Command('spotify-sync').description(
  'Sync a Spotify library, cross-reference it with Plex, and report what is missing.',
);

async function withApp<T>(fn: (a: { cfg: ReturnType<typeof loadConfig>; store: Store; log: ReturnType<typeof createLogger> }) => Promise<T> | T): Promise<T> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  const store = new Store(cfg.CONFIG_DIR);
  try {
    return await fn({ cfg, store, log });
  } finally {
    store.close();
  }
}

function printTracks(rows: ReturnType<Store['list']>, json: boolean): void {
  if (json) return void console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) {
    const conf = r.matchConfidence !== null ? ` (${r.matchConfidence.toFixed(2)})` : '';
    console.log(`${r.artists.join(', ')} - ${r.title} [${r.album}]${conf}`);
  }
  console.log(`\n${rows.length} track(s)`);
}

program
  .command('sync')
  .description('Pull the Spotify library and check it against Plex')
  .action(() => withApp(({ cfg, store, log }) => runSync(cfg, store, log).then(() => undefined)));

program
  .command('run')
  .description('One full pass: sync, then download/import/verify missing tracks (respects AUTO_DOWNLOAD / DRY_RUN)')
  .action(() => withApp(({ cfg, store, log }) => runCycle(cfg, store, log).then(() => undefined)));

program
  .command('daemon')
  .description('Run `run` forever every SYNC_INTERVAL (the container default)')
  .action(() => withApp(({ cfg, store, log }) => runDaemon(cfg, store, log)));

program
  .command('failed')
  .description('List tracks that failed and are parked')
  .option('-n, --limit <n>', 'max rows', '200')
  .option('--json', 'JSON output')
  .action((o: { limit: string; json?: boolean }) =>
    withApp(({ store }) => {
      const rows = store.list('failed', Number(o.limit));
      if (o.json) return void console.log(JSON.stringify(rows, null, 2));
      for (const r of rows) console.log(`${r.id}  ${r.artists.join(', ')} - ${r.title}\n    ${r.lastError ?? ''}`);
      console.log(`\n${rows.length} failed track(s). Use \`retry\` to queue them again.`);
    }),
  );

program
  .command('retry [trackId]')
  .description('Put failed track(s) back in the queue now (one Spotify track ID, or all)')
  .action((trackId?: string) =>
    withApp(({ store }) => console.log(`Re-queued ${store.retryFailed(trackId)} track(s)`)),
  );

program
  .command('auth')
  .description('One-time Spotify login that prints a SPOTIFY_REFRESH_TOKEN (run with docker -it)')
  .action(() => runAuth(loadConfig()));

program
  .command('status')
  .description('Show track counts by status')
  .action(() =>
    withApp(({ store }) => {
      const counts = store.counts();
      console.log(`Collections: ${store.collectionCount()}`);
      for (const [status, n] of Object.entries(counts).sort()) console.log(`  ${status.padEnd(12)} ${n}`);
      if (Object.keys(counts).length === 0) console.log('  (empty: run `sync` first)');
    }),
  );

for (const [name, status, desc] of [
  ['missing', 'missing', 'List tracks not found in Plex'],
  ['review', 'review', 'List low-confidence Plex matches that need a human look'],
] as const) {
  program
    .command(name)
    .description(desc)
    .option('-n, --limit <n>', 'max rows', '200')
    .option('--json', 'JSON output')
    .action((o: { limit: string; json?: boolean }) =>
      withApp(({ store }) => printTracks(store.list(status, Number(o.limit)), !!o.json)),
    );
}

program.parseAsync().catch((err: unknown) => {
  const log = createLogger('error');
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
