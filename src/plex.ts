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

export interface PlexPlaylistApi {
  listPlaylists(): Promise<{ id: string; title: string }[]>;
  playlistItems(id: string): Promise<string[]>;
  createPlaylist(title: string, keys: string[]): Promise<string>;
  replaceItems(id: string, keys: string[]): Promise<void>;
  renamePlaylist(id: string, title: string): Promise<void>;
  deletePlaylist(id: string): Promise<void>;
}

const PLAYLIST_CHUNK = 100;

export class PlexClient implements PlexPlaylistApi {
  private machine?: string;

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

  private async send(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'X-Plex-Token': this.token },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Plex HTTP ${res.status} for ${method} ${path}`);
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }

  private async machineId(): Promise<string> {
    if (!this.machine) {
      const root = await this.get<{ MediaContainer: { machineIdentifier?: string } }>('');
      const id = root.MediaContainer.machineIdentifier;
      if (!id) throw new Error('Plex did not report a machineIdentifier');
      this.machine = id;
    }
    return this.machine;
  }

  private async itemsUri(keys: string[]): Promise<string> {
    return `server://${await this.machineId()}/com.plexapp.plugins.library/library/metadata/${keys.join(',')}`;
  }

  async listPlaylists(): Promise<{ id: string; title: string }[]> {
    const data = await this.get<{ MediaContainer: { Metadata?: { ratingKey: string; title: string }[] } }>(
      'playlists',
      { playlistType: 'audio' },
    );
    return (data.MediaContainer.Metadata ?? []).map((m) => ({ id: m.ratingKey, title: m.title }));
  }

  async playlistItems(id: string): Promise<string[]> {
    const out: string[] = [];
    const size = 1000;
    for (let start = 0; ; start += size) {
      const data = await this.get<{ MediaContainer: { Metadata?: { ratingKey: string }[] } }>(
        `playlists/${id}/items`,
        { 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(size) },
      );
      const items = data.MediaContainer.Metadata ?? [];
      out.push(...items.map((m) => m.ratingKey));
      if (items.length < size) return out;
    }
  }

  /** Create a playlist (first chunk in the create call, the rest appended in chunks). Returns its id. */
  async createPlaylist(title: string, keys: string[]): Promise<string> {
    const res = (await this.send('POST', 'playlists', {
      type: 'audio',
      title,
      smart: '0',
      uri: await this.itemsUri(keys.slice(0, PLAYLIST_CHUNK)),
    })) as { MediaContainer?: { Metadata?: { ratingKey: string }[] } } | undefined;
    const id = res?.MediaContainer?.Metadata?.[0]?.ratingKey;
    if (!id) throw new Error('Plex did not return the new playlist id');
    await this.addItems(id, keys.slice(PLAYLIST_CHUNK));
    return id;
  }

  private async addItems(id: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += PLAYLIST_CHUNK) {
      await this.send('PUT', `playlists/${id}/items`, { uri: await this.itemsUri(keys.slice(i, i + PLAYLIST_CHUNK)) });
    }
  }

  /** Empty the playlist and refill it in order (keeps the playlist id and any artwork). */
  async replaceItems(id: string, keys: string[]): Promise<void> {
    await this.send('DELETE', `playlists/${id}/items`);
    await this.addItems(id, keys);
  }

  async renamePlaylist(id: string, title: string): Promise<void> {
    await this.send('PUT', `playlists/${id}`, { title });
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.send('DELETE', `playlists/${id}`);
  }

  /** Folder Plex itself uses for this library (may differ from our /music mount). */
  static rootOf(library: PlexDirectory): string | null {
    return library.Location?.[0]?.path ?? null;
  }

  /**
   * Ask Plex to scan one folder (path as Plex sees it), or the whole section if none given.
   * Plex's current API documents POST for this; older servers only accept GET, so fall back on 404/405.
   */
  async scan(library: PlexDirectory, plexPath?: string): Promise<void> {
    const path = `library/sections/${library.key}/refresh`;
    const params: Record<string, string> = plexPath ? { path: plexPath } : {};
    try {
      await this.send('POST', path, params);
    } catch (err) {
      if (!/HTTP (404|405)\b/.test(String(err))) throw err;
      await this.send('GET', path, params);
    }
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
