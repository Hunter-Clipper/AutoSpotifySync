import type { Store } from './db.js';
import type { Logger } from './logger.js';
import type { PlexPlaylistApi } from './plex.js';

export interface PlaylistSummary {
  dryRun: boolean;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  errors: number;
}

export interface PlaylistOptions {
  dryRun: boolean;
  deleteRemoved: boolean;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Mirror Spotify playlists (and Liked Songs) into Plex playlists, one way.
 * - Only tracks already in Plex are included, in Spotify's order.
 * - Only playlists this tool created (recorded in plex_playlists) are ever modified or deleted.
 * - A same-named playlist that we did not create is left alone and reported.
 */
export async function syncPlexPlaylists(
  store: Store,
  plex: PlexPlaylistApi,
  log: Logger,
  opts: PlaylistOptions,
): Promise<PlaylistSummary> {
  const sum: PlaylistSummary = { dryRun: opts.dryRun, created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0, errors: 0 };
  const tag = opts.dryRun ? '[dry-run] ' : '';
  const existing = await plex.listPlaylists();
  const byId = new Map(existing.map((p) => [p.id, p]));
  const tracked = store.plexPlaylists();
  const ourIds = new Set([...tracked.values()].map((t) => t.plexId));
  const collections = store.playlistCollections();

  for (const c of collections) {
    const title = c.name.trim() || 'Untitled Spotify playlist';
    const desired = store.plexKeysFor(c.id);
    const mine = tracked.get(c.id);
    try {
      if (!mine || !byId.has(mine.plexId)) {
        if (desired.length === 0) {
          sum.skipped++;
          log.debug('Playlist has no tracks in Plex yet, not creating', { playlist: title });
          continue;
        }
        const clash = existing.find((p) => p.title === title && !ourIds.has(p.id));
        if (clash) {
          sum.skipped++;
          log.warn('A Plex playlist with this name already exists and was not created by this tool; leaving it alone', { playlist: title });
          continue;
        }
        log.info(`${tag}Creating Plex playlist`, { playlist: title, tracks: desired.length });
        if (!opts.dryRun) store.setPlexPlaylist(c.id, await plex.createPlaylist(title, desired), title);
        sum.created++;
        continue;
      }

      if (mine.title !== title) {
        log.info(`${tag}Renaming Plex playlist`, { from: mine.title, to: title });
        if (!opts.dryRun) {
          await plex.renamePlaylist(mine.plexId, title);
          store.setPlexPlaylist(c.id, mine.plexId, title);
        }
      }
      const current = await plex.playlistItems(mine.plexId);
      if (same(current, desired)) {
        sum.unchanged++;
        continue;
      }
      log.info(`${tag}Updating Plex playlist`, { playlist: title, from: current.length, to: desired.length });
      if (!opts.dryRun) await plex.replaceItems(mine.plexId, desired);
      sum.updated++;
    } catch (err) {
      sum.errors++;
      log.warn('Playlist sync failed', { playlist: title, error: err });
    }
  }

  // Playlists we created whose Spotify source no longer exists.
  const live = new Set(collections.map((c) => c.id));
  for (const [collectionId, mine] of tracked) {
    if (live.has(collectionId)) continue;
    try {
      if (!opts.deleteRemoved) {
        log.info('Spotify playlist is gone; leaving the Plex copy (PLEX_PLAYLIST_DELETE_REMOVED=false)', { playlist: mine.title });
        continue;
      }
      log.info(`${tag}Deleting Plex playlist (removed from Spotify)`, { playlist: mine.title });
      if (!opts.dryRun) {
        if (byId.has(mine.plexId)) await plex.deletePlaylist(mine.plexId);
        store.deletePlexPlaylist(collectionId);
      }
      sum.deleted++;
    } catch (err) {
      sum.errors++;
      log.warn('Playlist delete failed', { playlist: mine.title, error: err });
    }
  }

  log.info(`${tag}Plex playlists synced`, { ...sum });
  return sum;
}
