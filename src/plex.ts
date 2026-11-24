import type { Logger } from './logger.js';
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

  /** Search the library's tracks by title text. */
  async searchTracks(library: PlexDirectory, query: string): Promise<PlexTrack[]> {
    const data = await this.get<{ MediaContainer: { Metadata?: PlexMeta[] } }>(
      `library/sections/${library.key}/search`,
      { type: '10', query },
    );
    return (data.MediaContainer.Metadata ?? []).map(toPlexTrack);
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
