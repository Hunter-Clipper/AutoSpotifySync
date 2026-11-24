import { normalizeArtist, normalizeTitle, similarity, versionTags } from './normalize.js';
import type { MatchStatus, PlexTrack, TrackRec } from './types.js';

interface Entry { plex: PlexTrack; title: string; versions: string; artists: string[]; album: string }

export interface MatchResult { status: MatchStatus; confidence: number; plexKey: string | null }

export interface MatchOptions { minConfidence: number; strictAlbum: boolean }

/** Below this a candidate is not even worth a human look. */
const REVIEW_FLOOR = 0.7;
/** When a title carries a version word (remix, live...), the rest must match almost exactly. */
const VERSIONED_TITLE_SIM = 0.92;
/** Candidates whose artist is less similar than this are never the same song. */
const MIN_ARTIST_SIM = 0.6;

export class PlexIndex {
  private byTitle = new Map<string, Entry[]>();
  private byArtist = new Map<string, Entry[]>();

  constructor(tracks: PlexTrack[]) {
    for (const plex of tracks) {
      const artists = [plex.artist, plex.trackArtist]
        .filter((a): a is string => !!a)
        .map(normalizeArtist);
      const title = normalizeTitle(plex.title);
      const entry: Entry = { plex, title, versions: versionTags(title), artists, album: normalizeTitle(plex.album) };
      push(this.byTitle, entry.title, entry);
      for (const a of new Set(artists)) push(this.byArtist, a, entry);
    }
  }

  candidates(track: TrackRec): Entry[] {
    const seen = new Set<Entry>();
    const title = normalizeTitle(track.title);
    for (const e of this.byTitle.get(title) ?? []) seen.add(e);
    for (const a of track.artists) for (const e of this.byArtist.get(normalizeArtist(a)) ?? []) seen.add(e);
    return [...seen];
  }

  match(track: TrackRec, opts: MatchOptions): MatchResult {
    const title = normalizeTitle(track.title);
    const album = normalizeTitle(track.album);
    const artists = track.artists.map(normalizeArtist);
    const versions = versionTags(title);
    let best: MatchResult = { status: 'missing', confidence: 0, plexKey: null };

    for (const e of this.candidates(track)) {
      if (opts.strictAlbum && similarity(album, e.album) < 0.8) continue;
      // A remix, live cut or bass-boosted edit is not the original song, and vice versa.
      if (versions !== e.versions) continue;
      const titleSim = similarity(title, e.title);
      // Same kind of version (e.g. two remixes): different remixers must not match each other.
      if (versions && titleSim < VERSIONED_TITLE_SIM) continue;
      let artistSim = 0;
      for (const a of artists) for (const b of e.artists) artistSim = Math.max(artistSim, similarity(a, b));
      // Compilations are filed under "Various Artists": the album then stands in for the artist.
      if (artistSim < MIN_ARTIST_SIM && e.artists.includes('various artists') && similarity(album, e.album) >= 0.8) artistSim = 0.9;
      // The artist is essential: a same-titled song by someone else is a different song.
      if (artistSim < MIN_ARTIST_SIM) continue;
      const score = titleSim * 0.65 + artistSim * 0.35;
      if (score > best.confidence) best = { status: 'missing', confidence: score, plexKey: e.plex.key };
    }

    if (best.confidence >= opts.minConfidence) best.status = 'matched';
    else if (best.confidence >= REVIEW_FLOOR) best.status = 'review';
    else best = { status: 'missing', confidence: best.confidence, plexKey: null };
    return best;
  }
}

function push(map: Map<string, Entry[]>, key: string, entry: Entry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}
