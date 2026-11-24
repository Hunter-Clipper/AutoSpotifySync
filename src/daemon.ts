import type { Config } from './config.js';
import type { Store } from './db.js';
import type { Logger } from './logger.js';
import { notify } from './notify.js';
import { PlexClient } from './plex.js';
import { syncPlexPlaylists, type PlaylistSummary } from './plexPlaylists.js';
import { runDownloads, type DownloadSummary } from './pipeline.js';
import { runSync, type SyncSummary } from './sync.js';
import { parseInterval, sleep } from './util.js';

export interface CycleResult { sync: SyncSummary; downloads: DownloadSummary; playlists?: PlaylistSummary }

export function summarize(r: CycleResult, counts: Record<string, number>): string {
  const d = r.downloads;
  const lines = [
    `Spotify: ${r.sync.tracks} tracks in ${r.sync.collections} collections (${r.sync.mode} mode)`,
    `Plex: ${r.sync.matched} matched, ${r.sync.review} to review, ${r.sync.missing} missing`,
  ];
  if (d.dryRun) lines.push(`Downloads (dry run): ${d.candidates} would be processed`);
  else if (d.candidates > 0) lines.push(`Downloads: ${d.completed} complete, ${d.failed} failed, ${d.deferred} deferred`);
  if (d.fatal) lines.push(`Stopped early: ${d.fatal}`);
  const pl = r.playlists;
  if (pl) {
    lines.push(
      `Plex playlists${pl.dryRun ? ' (dry run)' : ''}: ${pl.created} created, ${pl.updated} updated, ${pl.deleted} deleted, ${pl.unchanged} unchanged${pl.errors ? `, ${pl.errors} errors` : ''}`,
    );
  }
  lines.push(`Library: ${counts.complete ?? 0} downloaded, ${counts.failed ?? 0} failed, ${counts.missing ?? 0} missing`);
  return lines.join('\n');
}

/** Mirror Spotify playlists into Plex when PLEX_SYNC_PLAYLISTS is on. Honors DRY_RUN. */
export async function runPlaylistSync(cfg: Config, store: Store, log: Logger): Promise<PlaylistSummary | undefined> {
  if (!cfg.PLEX_SYNC_PLAYLISTS) return undefined;
  if (!cfg.PLEX_URL || !cfg.PLEX_TOKEN) throw new Error('PLEX_SYNC_PLAYLISTS needs PLEX_URL and PLEX_TOKEN');
  const plex = new PlexClient(cfg.PLEX_URL, cfg.PLEX_TOKEN, log);
  return syncPlexPlaylists(store, plex, log, { dryRun: cfg.DRY_RUN, deleteRemoved: cfg.PLEX_PLAYLIST_DELETE_REMOVED });
}

/** One full pass: sync Spotify, check Plex, then download/import/verify what is missing. */
export async function runCycle(cfg: Config, store: Store, log: Logger, signal?: AbortSignal): Promise<CycleResult> {
  const sync = await runSync(cfg, store, log);
  const downloads = await runDownloads(cfg, store, log, signal);
  const playlists = await runPlaylistSync(cfg, store, log);
  const result: CycleResult = { sync, downloads, ...(playlists ? { playlists } : {}) };
  const changed =
    downloads.completed + downloads.failed > 0 ||
    !!downloads.fatal ||
    (playlists ? playlists.created + playlists.updated + playlists.deleted + playlists.errors > 0 : false);
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
