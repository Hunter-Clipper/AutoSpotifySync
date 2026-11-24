import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, posix, resolve } from 'node:path';
import type { Config } from './config.js';
import { requireSettings } from './config.js';
import type { FullTrack, Store } from './db.js';
import { DownloaderClient, DownloaderError, type DownloaderLike } from './downloader.js';
import { destinationFor, extensionOf, moveInto } from './importer.js';
import type { Logger } from './logger.js';
import { PlexIndex } from './matcher.js';
import { realMedia, type MediaLike } from './media.js';
import { PlexClient } from './plex.js';
import type { PlexTrack } from './types.js';
import { RateLimiter, sleep } from './util.js';

/** What the pipeline needs from Plex (the real client is wrapped by `plexAdapter`). */
export interface PlexLike {
  scan(localFolder: string): Promise<void>;
  search(title: string): Promise<PlexTrack[]>;
}

export interface PipelineOptions {
  format: string;
  bitrate: string;
  toleranceSec: number;
  maxAttempts: number;
  cooldownDays: number;
  concurrency: number;
  ratePerMin: number;
  minConfidence: number;
  musicDir: string;
  stagingDir: string;
  pollMs: number;
  jobTimeoutMs: number;
  busyBackoffMs: number;
  plexWaitMs: number;
  plexPollMs: number;
  maxVerifyTries: number;
}

export interface DownloadSummary {
  dryRun: boolean;
  candidates: number;
  completed: number;
  failed: number;
  deferred: number;
  stopped: number;
  fatal?: string;
}

export const emptySummary = (dryRun = false): DownloadSummary => ({
  dryRun, candidates: 0, completed: 0, failed: 0, deferred: 0, stopped: 0,
});

/** Retry later without burning an attempt (downloader busy/unreachable, Plex slow to index). */
class Transient extends Error {}
/** Stop the whole run (e.g. bad API key): retrying other tracks would be pointless. */
class Fatal extends Error {}

type Outcome = 'complete' | 'failed' | 'deferred' | 'stopped';

export class Pipeline {
  private limiter: RateLimiter;
  private fatal?: Fatal;

  constructor(
    private o: PipelineOptions,
    private store: Store,
    private log: Logger,
    private downloader: DownloaderLike,
    private plex: PlexLike,
    private media: MediaLike,
    private signal?: AbortSignal,
  ) {
    this.limiter = new RateLimiter(o.ratePerMin);
  }

  async run(tracks: FullTrack[]): Promise<DownloadSummary> {
    const summary = emptySummary();
    summary.candidates = tracks.length;
    await mkdir(this.o.stagingDir, { recursive: true, mode: 0o775 });
    const queue = [...tracks];
    const worker = async () => {
      for (;;) {
        if (this.fatal || this.signal?.aborted) return;
        const t = queue.shift();
        if (!t) return;
        const outcome = await this.advance(t);
        if (outcome === 'complete') summary.completed++;
        else if (outcome === 'failed') summary.failed++;
        else if (outcome === 'deferred') summary.deferred++;
        else summary.stopped++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency, tracks.length) }, worker));
    summary.stopped += queue.length;
    if (this.fatal) summary.fatal = this.fatal.message;
    return summary;
  }

  private label(t: FullTrack): string {
    return `${t.artists[0] ?? '?'} - ${t.title}`;
  }

  /** Drive one track as far as it will go. Every step persists, so a restart resumes here. */
  private async advance(start: FullTrack): Promise<Outcome> {
    let t = start;
    let resubmits = 0;
    try {
      for (;;) {
        if (this.signal?.aborted) return 'stopped';
        switch (t.status) {
          case 'missing':
            t = await this.submit(t);
            break;
          case 'downloading': {
            const next = await this.waitAndFetch(t);
            if (next.status === 'missing' && ++resubmits > 3) throw new Error('downloader kept losing the job');
            t = next;
            break;
          }
          case 'downloaded':
            t = await this.importTrack(t);
            break;
          case 'imported':
            t = await this.verifyInPlex(t);
            break;
          case 'complete':
            this.log.info('Complete', { track: this.label(t) });
            return 'complete';
          default:
            return 'failed';
        }
      }
    } catch (err) {
      if (err instanceof Fatal) {
        this.fatal = err;
        this.log.error(err.message);
        return 'deferred';
      }
      if (err instanceof Transient || (err instanceof DownloaderError && err.transient)) {
        return this.defer(t, err.message);
      }
      return this.fail(t, err instanceof Error ? err.message : String(err));
    }
  }

  private defer(t: FullTrack, reason: string): Outcome {
    this.log.warn('Deferred', { track: this.label(t), reason });
    const cur = this.store.getTrack(t.id) ?? t;
    // Nothing started yet: wait before trying again. Otherwise stay where we are and resume next run.
    if (cur.status === 'missing') {
      this.store.patch(t.id, { nextAttemptAt: new Date(Date.now() + 10 * 60_000).toISOString(), lastError: reason });
    } else {
      this.store.patch(t.id, { lastError: reason });
    }
    return 'deferred';
  }

  private async fail(t: FullTrack, reason: string): Promise<Outcome> {
    const cur = this.store.getTrack(t.id) ?? t;
    if (cur.jobId) await this.downloader.deleteJob(cur.jobId).catch(() => undefined);
    if (cur.stagedPath) await rm(cur.stagedPath, { force: true });
    const attempts = cur.attempts + 1;
    const parked = attempts >= this.o.maxAttempts || cur.status === 'imported';
    const now = Date.now();
    this.store.patch(t.id, {
      status: parked ? 'failed' : 'missing',
      attempts,
      jobId: null,
      stagedPath: null,
      lastError: reason,
      nextAttemptAt: new Date(
        now + (parked ? this.o.cooldownDays * 86_400_000 : 5 * 60_000 * 2 ** (attempts - 1)),
      ).toISOString(),
    });
    this.log.warn(parked ? 'Failed (parked)' : 'Attempt failed, will retry', {
      track: this.label(t), attempt: attempts, of: this.o.maxAttempts, reason,
    });
    return parked ? 'failed' : 'deferred';
  }

  private fresh(id: string): FullTrack {
    const t = this.store.getTrack(id);
    if (!t) throw new Error(`track ${id} vanished`);
    return t;
  }

  private async submit(t: FullTrack): Promise<FullTrack> {
    await this.limiter.take(this.signal);
    for (let i = 0; ; i++) {
      try {
        const job = await this.downloader.createJob(t.id, this.o.format, this.o.bitrate);
        this.store.patch(t.id, { status: 'downloading', jobId: job.job_id, lastError: null });
        this.log.info('Download started', { track: this.label(t), job: job.job_id });
        return this.fresh(t.id);
      } catch (err) {
        if (err instanceof DownloaderError && err.kind === 'auth') throw new Fatal(err.message);
        if (err instanceof DownloaderError && err.kind === 'busy' && i < 4 && !this.signal?.aborted) {
          this.log.warn('Downloader busy, backing off', { attempt: i + 1 });
          await sleep(this.o.busyBackoffMs * (i + 1), this.signal);
          await this.limiter.take(this.signal);
          continue;
        }
        throw err;
      }
    }
  }

  private async waitAndFetch(t: FullTrack): Promise<FullTrack> {
    const jobId = t.jobId;
    if (!jobId) {
      this.store.patch(t.id, { status: 'missing' });
      return this.fresh(t.id);
    }
    const deadline = Date.now() + this.o.jobTimeoutMs;
    for (;;) {
      let job;
      try {
        job = await this.downloader.getJob(jobId);
      } catch (err) {
        if (err instanceof DownloaderError && err.kind === 'notfound') {
          this.log.warn('Downloader lost the job (restart?), resubmitting', { track: this.label(t) });
          this.store.patch(t.id, { status: 'missing', jobId: null });
          return this.fresh(t.id);
        }
        if (err instanceof DownloaderError && err.kind === 'auth') throw new Fatal(err.message);
        throw err;
      }
      if (job.status === 'done') {
        const ext = extensionOf(job.filename ?? '');
        if (!ext || ext === '.zip') throw new Error(`unexpected download "${job.filename}"`);
        const dest = join(this.o.stagingDir, `${t.id}${ext}`);
        await this.downloader.fetchFile(jobId, dest);
        await this.downloader.deleteJob(jobId).catch(() => undefined);
        this.store.patch(t.id, { status: 'downloaded', stagedPath: dest, jobId: null });
        return this.fresh(t.id);
      }
      if (job.status === 'failed') throw new Error(`downloader failed: ${job.error ?? 'unknown error'}`);
      if (Date.now() > deadline) throw new Error('timed out waiting for the downloader');
      if (this.signal?.aborted) return t;
      await sleep(this.o.pollMs, this.signal);
    }
  }

  private async importTrack(t: FullTrack): Promise<FullTrack> {
    const staged = t.stagedPath;
    if (!staged || !(await stat(staged).then(() => true, () => false))) {
      this.store.patch(t.id, { status: 'missing', stagedPath: null });
      return this.fresh(t.id);
    }
    const ext = extensionOf(staged);
    const check = await this.media.check(staged, t, this.o.toleranceSec, ext !== '.mp3');
    if (!check.ok) {
      const q = join(this.o.stagingDir, 'quarantine', `${t.id}${ext}`);
      await mkdir(dirname(q), { recursive: true });
      await rename(staged, q).catch(() => undefined);
      throw new Error(`file check failed: ${check.reason} (kept in quarantine)`);
    }
    if (ext === '.mp3') await this.media.writeTags(staged, t);
    const { file } = destinationFor(this.o.musicDir, t, ext);
    const result = await moveInto(staged, file);
    this.log.info(result === 'moved' ? 'Imported' : 'Already in library, skipped copy', { file });
    this.store.patch(t.id, { status: 'imported', finalPath: file, stagedPath: null, verifyTries: 0 });
    return this.fresh(t.id);
  }

  private async verifyInPlex(t: FullTrack): Promise<FullTrack> {
    if (!t.finalPath) {
      this.store.patch(t.id, { status: 'missing' });
      return this.fresh(t.id);
    }
    const tries = t.verifyTries + 1;
    this.store.patch(t.id, { verifyTries: tries });
    await this.plex.scan(dirname(t.finalPath));
    const deadline = Date.now() + this.o.plexWaitMs;
    for (;;) {
      const found = new PlexIndex(await this.plex.search(t.title)).match(t, {
        minConfidence: this.o.minConfidence,
        strictAlbum: false,
      });
      if (found.status === 'matched') {
        this.store.patch(t.id, { status: 'complete', plexKey: found.plexKey, lastError: null, nextAttemptAt: null });
        return this.fresh(t.id);
      }
      if (Date.now() > deadline || this.signal?.aborted) break;
      await sleep(this.o.plexPollMs, this.signal);
    }
    if (tries >= this.o.maxVerifyTries) throw new Error(`imported to ${t.finalPath} but Plex never listed it`);
    throw new Transient('imported, waiting for Plex to index it');
  }
}

export function optionsFromConfig(cfg: Config): PipelineOptions {
  return {
    format: cfg.DOWNLOAD_FORMAT,
    bitrate: cfg.DOWNLOAD_BITRATE,
    toleranceSec: cfg.DURATION_TOLERANCE_SEC,
    maxAttempts: cfg.RETRY_MAX_ATTEMPTS,
    cooldownDays: cfg.RETRY_COOLDOWN_DAYS,
    concurrency: cfg.DOWNLOAD_CONCURRENCY,
    ratePerMin: cfg.DOWNLOAD_RATE_PER_MIN,
    minConfidence: cfg.MATCH_MIN_CONFIDENCE,
    musicDir: cfg.MUSIC_DIR,
    stagingDir: cfg.STAGING_DIR ?? join(cfg.CONFIG_DIR, 'staging'),
    pollMs: 3000,
    jobTimeoutMs: 15 * 60_000,
    busyBackoffMs: 30_000,
    plexWaitMs: 90_000,
    plexPollMs: 6000,
    maxVerifyTries: 3,
  };
}

/** Stage 4-5: submit missing tracks to the downloader, import, verify. Honors DRY_RUN and AUTO_DOWNLOAD. */
export async function runDownloads(cfg: Config, store: Store, log: Logger, signal?: AbortSignal): Promise<DownloadSummary> {
  if (!cfg.AUTO_DOWNLOAD) {
    log.info('Auto-download is off (AUTO_DOWNLOAD=false); skipping downloads');
    return emptySummary();
  }
  store.reviveFailed();
  const resumable = store.resumable();
  const eligible = store.eligibleMissing(cfg.MAX_DOWNLOADS_PER_RUN);

  if (cfg.DRY_RUN) {
    log.info('[dry-run] downloads that would run', { resume: resumable.length, new: eligible.length });
    for (const t of eligible.slice(0, 50)) log.info(`[dry-run] would download: ${t.artists[0]} - ${t.title}`);
    if (eligible.length > 50) log.info(`[dry-run] ...and ${eligible.length - 50} more`);
    return { ...emptySummary(true), candidates: resumable.length + eligible.length };
  }

  requireSettings(cfg, ['DOWNLOADER_URL', 'DOWNLOADER_API_KEY', 'PLEX_URL', 'PLEX_TOKEN']);
  const opts = optionsFromConfig(cfg);
  const plexClient = new PlexClient(cfg.PLEX_URL, cfg.PLEX_TOKEN, log);
  const library = await plexClient.resolveLibrary(cfg.PLEX_MUSIC_LIBRARY);
  const plexRoot = PlexClient.rootOf(library);
  const plex: PlexLike = {
    search: (title) => plexClient.searchTracks(library, title),
    scan: async (localFolder) => {
      if (!plexRoot) return plexClient.scan(library);
      const rel = relative(resolve(opts.musicDir), resolve(localFolder)).split(/[\\/]/).join('/');
      return plexClient.scan(library, posix.join(plexRoot, rel));
    },
  };
  const pipeline = new Pipeline(
    opts, store, log, new DownloaderClient(cfg.DOWNLOADER_URL, cfg.DOWNLOADER_API_KEY), plex, realMedia, signal,
  );
  log.info('Running downloads', { resume: resumable.length, new: eligible.length });
  const summary = await pipeline.run([...resumable, ...eligible]);
  log.info('Downloads finished', { ...summary });
  return summary;
}
