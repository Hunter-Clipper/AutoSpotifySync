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
];

/** Statuses that a Plex re-check is allowed to overwrite. Later pipeline states are left alone. */
const RECHECKABLE = ['discovered', 'matched', 'review', 'missing'];

export interface TrackRow extends TrackRec {
  status: string;
  matchConfidence: number | null;
  plexKey: string | null;
  lastError: string | null;
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
