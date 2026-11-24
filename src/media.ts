import { stat } from 'node:fs/promises';
import NodeID3 from 'node-id3';
import { parseFile } from 'music-metadata';
import type { TrackRec } from './types.js';

export interface FileCheck { ok: boolean; reason?: string }

export interface MediaLike {
  /** Cheap sanity check: size, readable header, duration near Spotify's, tags present if required. */
  check(path: string, track: TrackRec, toleranceSec: number, requireTags: boolean): Promise<FileCheck>;
  /** Write canonical tags (mp3 only). */
  writeTags(path: string, track: TrackRec): Promise<void>;
}

const MIN_BYTES = 30_000;

export const realMedia: MediaLike = {
  async check(path, track, toleranceSec, requireTags) {
    const size = (await stat(path)).size;
    if (size < MIN_BYTES) return { ok: false, reason: `file too small (${size} bytes)` };
    let meta;
    try {
      meta = await parseFile(path, { duration: true });
    } catch (err) {
      return { ok: false, reason: `unreadable audio: ${err instanceof Error ? err.message : err}` };
    }
    const dur = meta.format.duration;
    if (!dur) return { ok: false, reason: 'could not determine duration' };
    const diff = Math.abs(dur - track.durationMs / 1000);
    if (diff > toleranceSec) {
      return { ok: false, reason: `duration ${dur.toFixed(1)}s differs from Spotify's ${(track.durationMs / 1000).toFixed(1)}s` };
    }
    if (requireTags && (!meta.common.title || !meta.common.artist)) return { ok: false, reason: 'missing title/artist tags' };
    return { ok: true };
  },

  async writeTags(path, track) {
    const tags: NodeID3.Tags = {
      title: track.title,
      artist: track.artists.join(', '),
      performerInfo: track.artists[0], // album artist, keeps the library grouped under one artist
      album: track.album,
      ...(track.trackNo ? { trackNumber: String(track.trackNo) } : {}),
      ...(track.isrc ? { ISRC: track.isrc } : {}),
    };
    // update() merges, so embedded cover art and lyrics from the downloader are kept.
    const result = NodeID3.update(tags, path);
    if (result instanceof Error) throw new Error(`tag write failed: ${result.message}`);
  },
};
