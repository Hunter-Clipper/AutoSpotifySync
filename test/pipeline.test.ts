import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { DownloaderError, type DownloaderLike, type JobStatus } from '../src/downloader.js';
import { createLogger } from '../src/logger.js';
import type { MediaLike } from '../src/media.js';
import { Pipeline, type PipelineOptions, type PlexLike } from '../src/pipeline.js';
import type { LibrarySnapshot, PlexTrack, TrackRec } from '../src/types.js';

const log = createLogger('error');
const rec = (id: string): TrackRec => ({
  id, title: `Song ${id}`, artists: ['Band'], album: 'Record', durationMs: 180000, isrc: null, trackNo: 1,
});

class FakeDownloader implements DownloaderLike {
  created: string[] = [];
  deleted: string[] = [];
  createErrors: DownloaderError[] = [];
  jobResult: (id: string) => Partial<JobStatus> = () => ({ status: 'done', filename: 'x.mp3' });
  lostJobs = new Set<string>();
  async createJob(id: string): Promise<JobStatus> {
    const e = this.createErrors.shift();
    if (e) throw e;
    this.created.push(id);
    return { job_id: `job-${id}-${this.created.length}`, status: 'running', error: null, filename: null };
  }
  async getJob(jobId: string): Promise<JobStatus> {
    if (this.lostJobs.has(jobId)) throw new DownloaderError('gone', 'notfound', 404);
    const id = jobId.split('-')[1]!;
    return { job_id: jobId, error: null, filename: null, status: 'running', ...this.jobResult(id) };
  }
  async fetchFile(_j: string, dest: string) {
    writeFileSync(dest, 'audio');
  }
  async deleteJob(j: string) {
    this.deleted.push(j);
  }
}

let dir: string;
let store: Store;
let dl: FakeDownloader;
let plexTracks: PlexTrack[];
let mediaOk = { ok: true } as { ok: boolean; reason?: string };

const media: MediaLike = { check: async () => mediaOk, writeTags: async () => undefined };
const plex: PlexLike = { scan: async () => undefined, search: async () => plexTracks };

const opts = (): PipelineOptions => ({
  format: 'mp3', bitrate: '320k', toleranceSec: 5, maxAttempts: 3, cooldownDays: 7, concurrency: 2,
  ratePerMin: 1000, minConfidence: 0.85, musicDir: join(dir, 'music'), stagingDir: join(dir, 'staging'),
  pollMs: 1, jobTimeoutMs: 2000, busyBackoffMs: 1, plexWaitMs: 20, plexPollMs: 5, maxVerifyTries: 2,
});
const make = (signal?: AbortSignal) => new Pipeline(opts(), store, log, dl, plex, media, signal);

function seed(ids: string[]) {
  const snap: LibrarySnapshot = {
    mode: 'full', tracks: new Map(ids.map((i) => [i, rec(i)])),
    collections: [{ id: 'c', name: 'c', kind: 'playlist-own', trackIds: ids }], failedCollectionIds: [],
  };
  store.saveSnapshot(snap);
  store.applyMatches(ids.map((id) => ({ id, status: 'missing' as const, confidence: 0, plexKey: null })));
}
const inPlex = (id: string): PlexTrack => ({
  key: `k${id}`, title: `Song ${id}`, artist: 'Band', trackArtist: null, album: 'Record',
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  store = new Store(join(dir, 'db'));
  dl = new FakeDownloader();
  plexTracks = [];
  mediaOk = { ok: true };
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Pipeline', () => {
  it('downloads, imports and verifies a track end to end', async () => {
    seed(['a']);
    plexTracks = [inPlex('a')];
    const s = await make().run(store.eligibleMissing(0));
    expect(s.completed).toBe(1);
    const t = store.getTrack('a')!;
    expect(t.status).toBe('complete');
    expect(t.plexKey).toBe('ka');
    expect(existsSync(join(dir, 'music/Band/Record/01 - Song a.mp3'))).toBe(true);
    expect(existsSync(join(dir, 'staging/a.mp3'))).toBe(false);
    expect(dl.deleted).toHaveLength(1);
  });

  it('retries with backoff, then parks the track after max attempts', async () => {
    seed(['a']);
    dl.jobResult = () => ({ status: 'failed', error: 'not found on youtube' });
    for (let i = 1; i <= 3; i++) {
      await make().run(store.eligibleMissing(0, '9999-01-01'));
      const t = store.getTrack('a')!;
      expect(t.attempts).toBe(i);
      expect(t.lastError).toContain('not found on youtube');
      expect(t.status).toBe(i < 3 ? 'missing' : 'failed');
    }
    expect(store.eligibleMissing(0, '9999-01-01')).toHaveLength(0);
    expect(store.list('failed', 10)).toHaveLength(1);
  });

  it('manual retry re-queues a parked track; cooldown expiry revives it', async () => {
    seed(['a', 'b']);
    store.patch('a', { status: 'failed', attempts: 3, nextAttemptAt: '2000-01-01T00:00:00.000Z' });
    store.patch('b', { status: 'failed', attempts: 3, nextAttemptAt: '9999-01-01T00:00:00.000Z' });
    expect(store.reviveFailed()).toBe(1);
    expect(store.getTrack('a')!.status).toBe('missing');
    expect(store.retryFailed('b')).toBe(1);
    expect(store.getTrack('b')!.attempts).toBe(0);
  });

  it('a busy downloader defers without burning an attempt', async () => {
    seed(['a']);
    dl.createErrors = Array.from({ length: 10 }, () => new DownloaderError('busy', 'busy', 503));
    const s = await make().run(store.eligibleMissing(0));
    expect(s.deferred).toBe(1);
    const t = store.getTrack('a')!;
    expect(t.attempts).toBe(0);
    expect(t.status).toBe('missing');
    expect(t.nextAttemptAt).not.toBeNull();
  });

  it('a busy downloader that recovers is retried transparently', async () => {
    seed(['a']);
    plexTracks = [inPlex('a')];
    dl.createErrors = [new DownloaderError('busy', 'busy', 503), new DownloaderError('busy', 'busy', 503)];
    expect((await make().run(store.eligibleMissing(0))).completed).toBe(1);
  });

  it('a bad API key stops the whole run', async () => {
    seed(['a', 'b', 'c']);
    dl.createErrors = [new DownloaderError('Downloader rejected the API key (401)', 'auth', 401)];
    const s = await make().run(store.eligibleMissing(0));
    expect(s.fatal).toContain('API key');
    expect(s.completed).toBe(0);
    expect(store.getTrack('a')!.attempts).toBe(0);
  });

  it('resubmits when the downloader lost the job (restart)', async () => {
    seed(['a']);
    plexTracks = [inPlex('a')];
    store.patch('a', { status: 'downloading', jobId: 'job-a-0' });
    dl.lostJobs.add('job-a-0');
    const s = await make().run([store.getTrack('a')!]);
    expect(s.completed).toBe(1);
    expect(dl.created).toEqual(['a']);
  });

  it('resumes a staged file after a restart without downloading again', async () => {
    seed(['a']);
    plexTracks = [inPlex('a')];
    await import('node:fs/promises').then((f) => f.mkdir(join(dir, 'staging'), { recursive: true }));
    writeFileSync(join(dir, 'staging/a.mp3'), 'audio');
    store.patch('a', { status: 'downloaded', stagedPath: join(dir, 'staging/a.mp3') });
    const s = await make().run([store.getTrack('a')!]);
    expect(s.completed).toBe(1);
    expect(dl.created).toHaveLength(0);
  });

  it('quarantines a file that fails the check and does not import it', async () => {
    seed(['a']);
    mediaOk = { ok: false, reason: 'duration 30.0s differs from Spotify\'s 180.0s' };
    await make().run(store.eligibleMissing(0));
    expect(existsSync(join(dir, 'staging/quarantine/a.mp3'))).toBe(true);
    expect(existsSync(join(dir, 'music'))).toBe(false);
    expect(store.getTrack('a')!.lastError).toContain('duration');
  });

  it('keeps an imported track pending while Plex has not indexed it, then fails after the limit', async () => {
    seed(['a']);
    plexTracks = [];
    const first = await make().run(store.eligibleMissing(0));
    expect(first.deferred).toBe(1);
    expect(store.getTrack('a')!.status).toBe('imported');
    const second = await make().run(store.resumable());
    expect(second.failed).toBe(1);
    expect(store.getTrack('a')!.status).toBe('failed');
  });

  it('stops promptly when aborted', async () => {
    seed(['a', 'b']);
    const ac = new AbortController();
    ac.abort();
    const s = await make(ac.signal).run(store.eligibleMissing(0));
    expect(s.stopped).toBe(2);
    expect(dl.created).toHaveLength(0);
  });
});
