export interface TrackRec {
  id: string; // Spotify track ID
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  isrc: string | null;
  trackNo: number | null;
}

export type CollectionKind = 'playlist-own' | 'playlist-followed' | 'public-playlist' | 'liked' | 'album';

export interface CollectionRec {
  id: string;
  name: string;
  kind: CollectionKind;
  trackIds: string[];
}

export interface LibrarySnapshot {
  mode: 'full' | 'public';
  tracks: Map<string, TrackRec>;
  collections: CollectionRec[];
  /** Collections that failed to fetch this run: keep their stored rows untouched. */
  failedCollectionIds: string[];
}

export interface PlexTrack {
  key: string;
  title: string;
  artist: string; // grandparentTitle (album artist)
  trackArtist: string | null; // originalTitle, when Plex has a per-track artist
  album: string;
  /** File paths Plex has for this track (Media[].Part[].file), as Plex sees them. */
  files?: string[];
}

export type MatchStatus = 'matched' | 'review' | 'missing';
