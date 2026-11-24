import type { Logger } from './logger.js';
import { normalizeArtist, similarity } from './normalize.js';
import type { PlexTrack } from './types.js';

export interface PlexDirectory { key: string; title: string; type: string; Location?: { path: string }[] }
interface PlexMeta {
  ratingKey: string;
  title: string;
  grandparentTitle?: string;
  originalTitle?: string;
  parentTitle?: string;
}

export class PlexClient {
  constructor(private baseUrl: string, private token: string, private log: Logger) {}

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Plex-Token': this.token },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Plex HTTP ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  /** Folder Plex itself uses for this library (may differ from our /music mount). */
  static rootOf(library: PlexDirectory): string | null {
    return library.Location?.[0]?.path ?? null;
  }

  /** Ask Plex to scan one folder (path as Plex sees it), or the whole section if none given. */
  async scan(library: PlexDirectory, plexPath?: string): Promise<void> {
    const url = new URL(`library/sections/${library.key}/refresh`, this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/');
    if (plexPath) url.searchParams.set('path', plexPath);
    const res = await fetch(url, { headers: { 'X-Plex-Token': this.token }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Plex scan request failed: HTTP ${res.status}`);
  }

  /**
   * Find tracks by title. Combines Plex's exact `title` filter with its free-text search and
   * merges the results: the text search can miss titles containing punctuation such as " - ".
   */
  async searchTracks(library: PlexDirectory, query: string): Promise<PlexTrack[]> {
    type Res = { MediaContainer: { Metadata?: PlexMeta[] } };
    const [filtered, searched] = await Promise.all([
      this.get<Res>(`library/sections/${library.key}/all`, { type: '10', title: query }).catch(() => undefined),
      this.get<Res>(`library/sections/${library.key}/search`, { type: '10', query }).catch(() => undefined),
    ]);
    if (!filtered && !searched) throw new Error('Plex track search failed');
    const byKey = new Map<string, PlexTrack>();
    for (const res of [filtered, searched]) {
      for (const m of res?.MediaContainer.Metadata ?? []) byKey.set(m.ratingKey, toPlexTrack(m));
    }
    return [...byKey.values()];
  }

  /**
   * All tracks by artists whose name matches `name`. Goes artist -> allLeaves instead of a text
   * search over track titles, so punctuation in a title cannot hide the track.
   */
  async tracksByArtist(library: PlexDirectory, name: string): Promise<PlexTrack[]> {
    if (!name) return [];
    const folded = name.normalize('NFKD').replace(/\p{M}/gu, '').replace(/Ø/g, 'O').replace(/ø/g, 'o');
    const wanted = normalizeArtist(name);
    const seen = new Set<string>();
    const out: PlexTrack[] = [];
    for (const query of new Set([name, folded])) {
      const found = await this.get<{ MediaContainer: { Metadata?: PlexMeta[] } }>(
        `library/sections/${library.key}/search`,
        { type: '8', query },
      );
      const artists = (found.MediaContainer.Metadata ?? [])
        .filter((a) => similarity(normalizeArtist(a.title), wanted) >= 0.8)
        .slice(0, 3);
      for (const a of artists) {
        if (seen.has(a.ratingKey)) continue;
        seen.add(a.ratingKey);
        const leaves = await this.get<{ MediaContainer: { Metadata?: PlexMeta[] } }>(
          `library/metadata/${a.ratingKey}/allLeaves`,
        );
        out.push(...(leaves.MediaContainer.Metadata ?? []).map(toPlexTrack));
      }
      if (out.length) break;
    }
    return out;
  }

  /** Resolve the music library: by name if given, else the only music library. */
  async resolveLibrary(name?: string): Promise<PlexDirectory> {
    const data = await this.get<{ MediaContainer: { Directory?: PlexDirectory[] } }>('library/sections');
    const music = (data.MediaContainer.Directory ?? []).filter((d) => d.type === 'artist');
    const names = music.map((d) => d.title).join(', ') || '(none)';
    if (name) {
      const hit = music.find((d) => d.title.toLowerCase() === name.toLowerCase());
      if (!hit) throw new Error(`Plex music library "${name}" not found. Available music libraries: ${names}`);
      return hit;
    }
    if (music.length === 1) return music[0]!;
    throw new Error(`Set PLEX_MUSIC_LIBRARY. Available music libraries: ${names}`);
  }

  async listTracks(library: PlexDirectory): Promise<PlexTrack[]> {
    const out: PlexTrack[] = [];
    const size = 1000;
    for (let start = 0; ; start += size) {
      const data = await this.get<{ MediaContainer: { totalSize?: number; Metadata?: PlexMeta[] } }>(
        `library/sections/${library.key}/all`,
        { type: '10', 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(size) },
      );
      const items = data.MediaContainer.Metadata ?? [];
      for (const m of items) out.push(toPlexTrack(m));
      if (items.length < size) break;
    }
    this.log.info('Loaded Plex tracks', { library: library.title, count: out.length });
    return out;
  }
}

function toPlexTrack(m: PlexMeta): PlexTrack {
  return {
    key: m.ratingKey,
    title: m.title,
    artist: m.grandparentTitle ?? '',
    trackArtist: m.originalTitle ?? null,
    album: m.parentTitle ?? '',
  };
}
