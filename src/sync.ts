import type { Config } from './config.js';
import { requireSettings } from './config.js';
import type { Store } from './db.js';
import type { Logger } from './logger.js';
import { PlexIndex } from './matcher.js';
import { PlexClient } from './plex.js';
import { SpotifyClient } from './spotify.js';

export interface SyncSummary {
  mode: 'full' | 'public';
  collections: number;
  tracks: number;
  matched: number;
  review: number;
  missing: number;
}

/** Milestones 2-3: pull Spotify into SQLite, then check every pending track against Plex. */
export async function runSync(cfg: Config, store: Store, log: Logger): Promise<SyncSummary> {
  requireSettings(cfg, ['PLEX_URL', 'PLEX_TOKEN']);

  const spotify = new SpotifyClient(cfg, log);
  log.info('Syncing Spotify', { mode: spotify.mode });
  const snap = await spotify.fetchLibrary();
  const saved = store.saveSnapshot(snap);
  log.info('Saved Spotify library', saved);

  const plex = new PlexClient(cfg.PLEX_URL, cfg.PLEX_TOKEN, log);
  const library = await plex.resolveLibrary(cfg.PLEX_MUSIC_LIBRARY);
  const index = new PlexIndex(await plex.listTracks(library));

  const opts = { minConfidence: cfg.MATCH_MIN_CONFIDENCE, strictAlbum: cfg.MATCH_STRICT_ALBUM };
  const results = store.tracksToMatch().map((t) => ({ id: t.id, ...index.match(t, opts) }));
  store.applyMatches(results);

  const count = (s: string) => results.filter((r) => r.status === s).length;
  const summary: SyncSummary = {
    mode: spotify.mode,
    collections: saved.collections,
    tracks: saved.tracks,
    matched: count('matched'),
    review: count('review'),
    missing: count('missing'),
  };
  log.info('Sync complete', { ...summary });
  return summary;
}
