import type { Config } from './config.js';
import { registerSecret, type Logger } from './logger.js';
import type { CollectionRec, LibrarySnapshot, TrackRec } from './types.js';

const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

interface SpArtist { name: string }
interface SpTrack {
  id: string | null;
  name: string;
  type?: string;
  is_local?: boolean;
  duration_ms: number;
  track_number?: number;
  artists: SpArtist[];
  album?: { name: string };
  external_ids?: { isrc?: string };
}
interface Page<T> { items: T[]; next: string | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseSpotifyUrl(url: string): { type: 'playlist' | 'album'; id: string } | null {
  const m = url.match(/(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(playlist|album)[/:]([A-Za-z0-9]{22})/);
  return m ? { type: m[1] as 'playlist' | 'album', id: m[2]! } : null;
}

export class SpotifyClient {
  private cached?: { value: string; expiresAt: number };
  readonly mode: 'full' | 'public';

  constructor(private cfg: Config, private log: Logger) {
    this.mode = cfg.SPOTIFY_REFRESH_TOKEN ? 'full' : 'public';
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 30_000) return this.cached.value;
    const basic = Buffer.from(`${this.cfg.SPOTIFY_CLIENT_ID}:${this.cfg.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const body = this.cfg.SPOTIFY_REFRESH_TOKEN
      ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.cfg.SPOTIFY_REFRESH_TOKEN })
      : new URLSearchParams({ grant_type: 'client_credentials' });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      if (detail.includes('invalid_grant')) {
        throw new Error(
          'Spotify refresh token is expired or revoked (they last about 6 months). Generate a new SPOTIFY_REFRESH_TOKEN.',
        );
      }
      throw new Error(`Spotify token request failed: HTTP ${res.status} ${detail}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    registerSecret(json.access_token);
    this.cached = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private async request<T>(pathOrUrl: string, attempt = 0): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.token()}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after') ?? '2');
      this.log.warn('Spotify rate limited, waiting', { seconds: wait });
      await sleep((wait + 1) * 1000);
      return this.request<T>(pathOrUrl, attempt + 1);
    }
    if (res.status === 401 && attempt < 1) {
      this.cached = undefined;
      return this.request<T>(pathOrUrl, attempt + 1);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`Spotify HTTP ${res.status} for ${url.replace(API, '')}: ${detail}`);
    }
    return (await res.json()) as T;
  }

  private async *pages<T>(first: string): AsyncGenerator<T> {
    let next: string | null = first;
    while (next) {
      const page: Page<T> = await this.request<Page<T>>(next);
      yield* page.items;
      next = page.next;
    }
  }

  private toTrack(t: SpTrack | null | undefined, albumName?: string): TrackRec | null {
    if (!t || !t.id || t.is_local || (t.type && t.type !== 'track')) return null;
    return {
      id: t.id,
      title: t.name,
      artists: t.artists.map((a) => a.name),
      album: t.album?.name ?? albumName ?? '',
      durationMs: t.duration_ms,
      isrc: t.external_ids?.isrc ?? null,
      trackNo: t.track_number ?? null,
    };
  }

  /**
   * Playlist entries. Spotify's Feb 2026 API change moved this to /items (entries under `item`)
   * and removed /tracks. We try /items first and fall back to /tracks for older behavior.
   * In development mode Spotify only returns contents for playlists the user owns or collaborates on.
   */
  private async playlistTracks(id: string): Promise<TrackRec[]> {
    const collect = async (suffix: string) => {
      const out: TrackRec[] = [];
      for await (const it of this.pages<{ item?: SpTrack | null; track?: SpTrack | null }>(
        `/playlists/${id}/${suffix}?limit=50`,
      )) {
        const t = this.toTrack(it.item ?? it.track);
        if (t) out.push(t);
      }
      return out;
    };
    try {
      return await collect('items');
    } catch (err) {
      if (!String(err).includes('HTTP 404')) throw err;
      return await collect('tracks');
    }
  }

  private async albumTracks(id: string): Promise<{ name: string; tracks: TrackRec[] }> {
    const album = await this.request<{ name: string; tracks: Page<SpTrack> }>(`/albums/${id}`);
    const tracks: TrackRec[] = [];
    const add = (items: SpTrack[]) => {
      for (const it of items) {
        const t = this.toTrack(it, album.name);
        if (t) tracks.push(t);
      }
    };
    add(album.tracks.items);
    if (album.tracks.next) for await (const it of this.pages<SpTrack>(album.tracks.next)) add([it]);
    return { name: album.name, tracks };
  }

  async fetchLibrary(): Promise<LibrarySnapshot> {
    const snap: LibrarySnapshot = { mode: this.mode, tracks: new Map(), collections: [], failedCollectionIds: [] };
    const addCollection = (id: string, name: string, kind: CollectionRec['kind'], tracks: TrackRec[]) => {
      for (const t of tracks) if (!snap.tracks.has(t.id)) snap.tracks.set(t.id, t);
      snap.collections.push({ id, name, kind, trackIds: tracks.map((t) => t.id) });
    };
    const attempt = async (id: string, label: string, fn: () => Promise<void>) => {
      try {
        await fn();
        this.log.info('Fetched', { collection: label });
      } catch (err) {
        snap.failedCollectionIds.push(id);
        const hint = String(err).includes('HTTP 403')
          ? 'Spotify only returns playlist contents for playlists you own or collaborate on'
          : undefined;
        this.log.warn('Skipping collection (fetch failed)', { collection: label, error: err, hint });
      }
    };

    if (this.mode === 'public') {
      const urls = (this.cfg.SPOTIFY_PLAYLIST_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
      if (urls.length === 0) {
        throw new Error(
          'No SPOTIFY_REFRESH_TOKEN is set. To sync your whole library, run the `auth` command once and set the token it prints. (Public-only mode instead needs SPOTIFY_PLAYLIST_URLS with at least one album URL.)',
        );
      }
      this.log.warn(
        'Public-only mode cannot read playlist contents (Spotify requires a user token); albums work, playlists will be skipped',
      );
      for (const url of urls) {
        const ref = parseSpotifyUrl(url);
        if (!ref) {
          this.log.warn('Ignoring unrecognized Spotify URL', { url });
          continue;
        }
        const id = `${ref.type}:${ref.id}`;
        await attempt(id, id, async () => {
          if (ref.type === 'playlist') {
            const meta = await this.request<{ name: string }>(`/playlists/${ref.id}?fields=name`);
            addCollection(id, meta.name, 'public-playlist', await this.playlistTracks(ref.id));
          } else {
            const a = await this.albumTracks(ref.id);
            addCollection(id, a.name, 'album', a.tracks);
          }
        });
      }
      return snap;
    }

    const me = await this.request<{ id: string }>('/me');
    for await (const pl of this.pages<{ id: string; name: string; owner: { id: string } }>('/me/playlists?limit=50')) {
      const kind = pl.owner.id === me.id ? 'playlist-own' : 'playlist-followed';
      await attempt(`playlist:${pl.id}`, pl.name, async () => {
        addCollection(`playlist:${pl.id}`, pl.name, kind, await this.playlistTracks(pl.id));
      });
    }
    await attempt('liked', 'Liked Songs', async () => {
      const tracks: TrackRec[] = [];
      for await (const it of this.pages<{ track: SpTrack }>('/me/tracks?limit=50')) {
        const t = this.toTrack(it.track);
        if (t) tracks.push(t);
      }
      addCollection('liked', 'Liked Songs', 'liked', tracks);
    });
    for await (const it of this.pages<{ album: { id: string; name: string } }>('/me/albums?limit=50')) {
      await attempt(`album:${it.album.id}`, it.album.name, async () => {
        const a = await this.albumTracks(it.album.id);
        addCollection(`album:${it.album.id}`, a.name, 'album', a.tracks);
      });
    }
    return snap;
  }
}
