import type { Config } from './config.js';
import type { Store } from './db.js';
import type { Logger } from './logger.js';
import { notify } from './notify.js';
import { runDownloads, type DownloadSummary } from './pipeline.js';
import { runSync, type SyncSummary } from './sync.js';
import { parseInterval, sleep } from './util.js';

export interface CycleResult { sync: SyncSummary; downloads: DownloadSummary }

export function summarize(r: CycleResult, counts: Record<string, number>): string {
  const d = r.downloads;
  const lines = [
    `Spotify: ${r.sync.tracks} tracks in ${r.sync.collections} collections (${r.sync.mode} mode)`,
    `Plex: ${r.sync.matched} matched, ${r.sync.review} to review, ${r.sync.missing} missing`,
  ];
  if (d.dryRun) lines.push(`Downloads (dry run): ${d.candidates} would be processed`);
  else if (d.candidates > 0) lines.push(`Downloads: ${d.completed} complete, ${d.failed} failed, ${d.deferred} deferred`);
  if (d.fatal) lines.push(`Stopped early: ${d.fatal}`);
  lines.push(`Library: ${counts.complete ?? 0} downloaded, ${counts.failed ?? 0} failed, ${counts.missing ?? 0} missing`);
  return lines.join('\n');
}

/** One full pass: sync Spotify, check Plex, then download/import/verify what is missing. */
export async function runCycle(cfg: Config, store: Store, log: Logger, signal?: AbortSignal): Promise<CycleResult> {
  const sync = await runSync(cfg, store, log);
  const downloads = await runDownloads(cfg, store, log, signal);
  const result = { sync, downloads };
  const changed = downloads.completed + downloads.failed > 0 || !!downloads.fatal;
  if (cfg.NOTIFY_ON === 'always' || changed) {
    await notify(cfg.NOTIFY_URL, 'AutoSpotifySync run finished', summarize(result, store.counts()), log);
  }
  return result;
}

/** Run cycles forever on SYNC_INTERVAL. SIGTERM/SIGINT finish in-flight work cleanly. */
export async function runDaemon(cfg: Config, store: Store, log: Logger): Promise<void> {
  const interval = parseInterval(cfg.SYNC_INTERVAL);
  const stop = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (!stop.signal.aborted) log.info(`${sig} received, finishing current work then exiting`);
      stop.abort();
    });
  }
  log.info('Daemon started', {
    interval: cfg.SYNC_INTERVAL, autoDownload: cfg.AUTO_DOWNLOAD, dryRun: cfg.DRY_RUN,
  });
  while (!stop.signal.aborted) {
    try {
      await runCycle(cfg, store, log, stop.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Cycle failed', { error: msg });
      await notify(cfg.NOTIFY_URL, 'AutoSpotifySync cycle failed', msg, log);
    }
    await sleep(interval, stop.signal);
  }
  log.info('Daemon stopped');
}
