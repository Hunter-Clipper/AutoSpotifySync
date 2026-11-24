import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { LibrarySnapshot, MatchStatus, TrackRec } from './types.js';

const MIGRATIONS: string[] = [
  `CREATE TABLE tracks (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     artists TEXT NOT NULL,          -- JSON array
     album TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     isrc TEXT,
     track_no INTEGER,
     status TEXT NOT NULL DEFAULT 'discovered',
     match_confidence REAL,
     plex_key TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     first_seen TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_tracks_status ON tracks(status);
   CREATE TABLE collections (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE collection_tracks (
     collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
     track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     PRIMARY KEY (collection_id, position)
   );
   CREATE INDEX idx_ct_track ON collection_tracks(track_id);`,
  `ALTER TABLE tracks ADD COLUMN job_id TEXT;
   ALTER TABLE tracks ADD COLUMN staged_path TEXT;
   ALTER TABLE tracks ADD COLUMN final_path TEXT;
   ALTER TABLE tracks ADD COLUMN next_attempt_at TEXT;
   ALTER TABLE tracks ADD COLUMN verify_tries INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE plex_playlists (
     collection_id TEXT PRIMARY KEY,   -- no FK: we still need the row after Spotify drops the collection
     plex_playlist_id TEXT NOT NULL,
     title TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
];

/** Statuses that a Plex re-check is allowed to overwrite. Later pipeline states are left alone. */
const RECHECKABLE = ['discovered', 'matched', 'review', 'missing'];

export interface TrackRow extends TrackRec {
  status: string;
  matchConfidence: number | null;
  plexKey: string | null;
  lastError: string | null;
}

/** Pipeline bookkeeping for a track. */
export interface TrackState {
  status: string;
  attempts: number;
  jobId: string | null;
  stagedPath: string | null;
  finalPath: string | null;
  nextAttemptAt: string | null;
  verifyTries: number;
  lastError: string | null;
  plexKey: string | null;
}
export type FullTrack = TrackRec & TrackState;
export type StatePatch = Partial<TrackState>;

const PATCH_COLUMNS: Record<keyof TrackState, string> = {
  status: 'status', attempts: 'attempts', jobId: 'job_id', stagedPath: 'staged_path',
  finalPath: 'final_path', nextAttemptAt: 'next_attempt_at', verifyTries: 'verify_tries',
  lastError: 'last_error', plexKey: 'plex_key',
};

interface RawFull extends RawRow {
  attempts: number; job_id: string | null; staged_path: string | null; final_path: string | null;
  next_attempt_at: string | null; verify_tries: number;
}

interface RawRow {
  id: string; title: string; artists: string; album: string; duration_ms: number; isrc: string | null;
  track_no: number | null; status: string; match_confidence: number | null; plex_key: string | null;
  last_error: string | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    // File name predates the Spotilex rename; kept so existing installs keep their data.
    this.db = new DatabaseSync(join(dir, 'autospotifysync.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  saveSnapshot(snap: LibrarySnapshot): { tracks: number; collections: number } {
    return this.tx(() => {
      const upTrack = this.db.prepare(
        `INSERT INTO tracks (id, title, artists, album, duration_ms, isrc, track_no)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, artists=excluded.artists, album=excluded.album,
           duration_ms=excluded.duration_ms, isrc=COALESCE(excluded.isrc, tracks.isrc),
           track_no=COALESCE(excluded.track_no, tracks.track_no), updated_at=datetime('now')`,
      );
      for (const t of snap.tracks.values()) {
        upTrack.run(t.id, t.title, JSON.stringify(t.artists), t.album, t.durationMs, t.isrc, t.trackNo);
      }

      const upColl = this.db.prepare(
        `INSERT INTO collections (id, name, kind) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, updated_at=datetime('now')`,
      );
      const delLinks = this.db.prepare('DELETE FROM collection_tracks WHERE collection_id = ?');
      const addLink = this.db.prepare(
        'INSERT OR IGNORE INTO collection_tracks (collection_id, track_id, position) VALUES (?, ?, ?)',
      );
      for (const c of snap.collections) {
        upColl.run(c.id, c.name, c.kind);
        delLinks.run(c.id);
        c.trackIds.forEach((tid, i) => addLink.run(c.id, tid, i));
      }

      // Drop collections that no longer exist upstream (but never ones that merely failed to fetch).
      const keep = new Set([...snap.collections.map((c) => c.id), ...snap.failedCollectionIds]);
      for (const row of this.db.prepare('SELECT id FROM collections').all() as { id: string }[]) {
        if (!keep.has(row.id)) this.db.prepare('DELETE FROM collections WHERE id = ?').run(row.id);
      }
      return { tracks: snap.tracks.size, collections: snap.collections.length };
    });
  }

  /** Tracks still in a state where a Plex check applies. Tracks no longer in any collection are skipped. */
  tracksToMatch(): TrackRec[] {
    const marks = RECHECKABLE.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks WHERE status IN (${marks})
         AND id IN (SELECT track_id FROM collection_tracks)`,
      )
      .all(...RECHECKABLE) as unknown as RawRow[];
    return rows.map(toRec);
  }

  applyMatches(results: { id: string; status: MatchStatus; confidence: number; plexKey: string | null }[]): void {
    this.tx(() => {
      const up = this.db.prepare(
        `UPDATE tracks SET status=?, match_confidence=?, plex_key=?, updated_at=datetime('now') WHERE id=?`,
      );
      for (const r of results) up.run(r.status, r.confidence, r.plexKey, r.id);
    });
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM tracks GROUP BY status').all() as {
      status: string; n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  collectionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number }).n;
  }

  list(status: string, limit: number): TrackRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tracks WHERE status = ? ORDER BY artists, album, track_no LIMIT ?')
      .all(status, limit as SQLInputValue) as unknown as RawRow[];
    return rows.map((r) => ({
      ...toRec(r),
      status: r.status,
      matchConfidence: r.match_confidence,
      plexKey: r.plex_key,
      lastError: r.last_error,
    }));
  }

  private toFull(r: RawFull): FullTrack {
    return {
      ...toRec(r),
      status: r.status, attempts: r.attempts, jobId: r.job_id, stagedPath: r.staged_path,
      finalPath: r.final_path, nextAttemptAt: r.next_attempt_at, verifyTries: r.verify_tries,
      lastError: r.last_error, plexKey: r.plex_key,
    };
  }

  getTrack(id: string): FullTrack | undefined {
    const r = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as unknown as RawFull | undefined;
    return r ? this.toFull(r) : undefined;
  }

  /** Update pipeline fields. Only whitelisted columns can be written. */
  patch(id: string, p: StatePatch): void {
    const entries = Object.entries(p) as [keyof TrackState, unknown][];
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${PATCH_COLUMNS[k]} = ?`).join(', ');
    this.db
      .prepare(`UPDATE tracks SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...(entries.map(([, v]) => v ?? null) as SQLInputValue[]), id);
  }

  /** Tracks mid-pipeline (survive restarts): downloading, downloaded, imported. */
  resumable(): FullTrack[] {
    const rows = this.db
      .prepare(`SELECT * FROM tracks WHERE status IN ('downloading','downloaded','imported') ORDER BY updated_at`)
      .all() as unknown as RawFull[];
    return rows.map((r) => this.toFull(r));
  }

  /** Missing tracks whose backoff has elapsed, oldest first. limit 0 = no limit. */
  eligibleMissing(limit: number, nowIso = new Date().toISOString()): FullTrack[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks WHERE status = 'missing' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND id IN (SELECT track_id FROM collection_tracks) ORDER BY first_seen, id LIMIT ?`,
      )
      .all(nowIso, (limit > 0 ? limit : -1) as SQLInputValue) as unknown as RawFull[];
    return rows.map((r) => this.toFull(r));
  }

  /** Failed tracks past their cooldown go back to missing with a clean slate. */
  reviveFailed(nowIso = new Date().toISOString()): number {
    return Number(
      this.db
        .prepare(
          `UPDATE tracks SET status='missing', attempts=0, next_attempt_at=NULL, updated_at=datetime('now')
           WHERE status='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?`,
        )
        .run(nowIso).changes,
    );
  }

  /** Manual retry: put failed track(s) (one id, or all) back in the queue immediately. */
  retryFailed(id?: string): number {
    const base = `UPDATE tracks SET status='missing', attempts=0, next_attempt_at=NULL, last_error=NULL,
                  updated_at=datetime('now') WHERE status='failed'`;
    const res = id ? this.db.prepare(`${base} AND id = ?`).run(id) : this.db.prepare(base).run();
    return Number(res.changes);
  }

  /** Collections that become Plex playlists (everything except albums, which Plex already shows). */
  playlistCollections(): { id: string; name: string; kind: string }[] {
    return this.db
      .prepare(
        `SELECT id, name, kind FROM collections
         WHERE kind IN ('playlist-own','playlist-followed','public-playlist','liked') ORDER BY name`,
      )
      .all() as { id: string; name: string; kind: string }[];
  }

  /** Plex rating keys for a collection's tracks that are in Plex, in Spotify's order. */
  plexKeysFor(collectionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.plex_key AS k FROM collection_tracks ct JOIN tracks t ON t.id = ct.track_id
         WHERE ct.collection_id = ? AND t.status IN ('matched','complete') AND t.plex_key IS NOT NULL
         ORDER BY ct.position`,
      )
      .all(collectionId) as { k: string }[];
    return rows.map((r) => r.k);
  }

  plexPlaylists(): Map<string, { plexId: string; title: string }> {
    const rows = this.db
      .prepare('SELECT collection_id, plex_playlist_id, title FROM plex_playlists')
      .all() as { collection_id: string; plex_playlist_id: string; title: string }[];
    return new Map(rows.map((r) => [r.collection_id, { plexId: r.plex_playlist_id, title: r.title }]));
  }

  setPlexPlaylist(collectionId: string, plexId: string, title: string): void {
    this.db
      .prepare(
        `INSERT INTO plex_playlists (collection_id, plex_playlist_id, title) VALUES (?, ?, ?)
         ON CONFLICT(collection_id) DO UPDATE SET plex_playlist_id=excluded.plex_playlist_id,
           title=excluded.title, updated_at=datetime('now')`,
      )
      .run(collectionId, plexId, title);
  }

  deletePlexPlaylist(collectionId: string): void {
    this.db.prepare('DELETE FROM plex_playlists WHERE collection_id = ?').run(collectionId);
  }

  close(): void {
    this.db.close();
  }
}

function toRec(r: RawRow): TrackRec {
  return {
    id: r.id,
    title: r.title,
    artists: JSON.parse(r.artists) as string[],
    album: r.album,
    durationMs: r.duration_ms,
    isrc: r.isrc,
    trackNo: r.track_no,
  };
}
