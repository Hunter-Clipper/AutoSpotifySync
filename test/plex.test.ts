import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { PlexClient, type PlexDirectory } from '../src/plex.js';

const lib: PlexDirectory = { key: '7', title: 'Music', type: 'artist', Location: [{ path: '/data/Music' }] };
const meta = (ratingKey: string, title: string, artist = 'BØRNS') => ({
  ratingKey, title, grandparentTitle: artist, parentTitle: 'Album',
});

let calls: URL[];
function stub(routes: (u: URL) => unknown | Error) {
  calls = [];
  vi.stubGlobal('fetch', async (input: URL | string) => {
    const u = new URL(input.toString());
    calls.push(u);
    const body = routes(u);
    if (body instanceof Error) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}
const client = () => new PlexClient('http://plex:32400', 'TOKEN', createLogger('error'));
const container = (Metadata: unknown[]) => ({ MediaContainer: { Metadata } });

beforeEach(() => void 0);
afterEach(() => vi.unstubAllGlobals());

describe('PlexClient.searchTracks', () => {
  it('merges the exact-title filter with the text search and dedupes', async () => {
    stub((u) =>
      u.pathname.endsWith('/all')
        ? container([meta('1', 'Electric Love - Oliver Remix')])
        : container([meta('1', 'Electric Love - Oliver Remix'), meta('2', 'Electric Love')]),
    );
    const r = await client().searchTracks(lib, 'Electric Love - Oliver Remix');
    expect(r.map((t) => t.key).sort()).toEqual(['1', '2']);
    const all = calls.find((u) => u.pathname.endsWith('/all'))!;
    expect(all.searchParams.get('title')).toBe('Electric Love - Oliver Remix');
    expect(all.searchParams.get('type')).toBe('10');
  });

  it('still works if only one of the two requests succeeds', async () => {
    stub((u) => (u.pathname.endsWith('/search') ? new Error('x') : container([meta('1', 'T')])));
    expect(await client().searchTracks(lib, 'T')).toHaveLength(1);
  });

  it('throws when both fail', async () => {
    stub(() => new Error('x'));
    await expect(client().searchTracks(lib, 'T')).rejects.toThrow(/search failed/);
  });

  it('sends the token as a header, never in the URL', async () => {
    stub(() => container([]));
    await client().searchTracks(lib, 'T');
    expect(calls.every((u) => !u.toString().includes('TOKEN'))).toBe(true);
  });
});

describe('PlexClient.tracksByArtist', () => {
  it('finds the artist, then lists their tracks', async () => {
    stub((u) => {
      if (u.pathname.endsWith('/search')) return container([{ ratingKey: '50', title: 'BØRNS' }, { ratingKey: '51', title: 'Someone Else' }]);
      if (u.pathname === '/library/metadata/50/allLeaves') return container([meta('9', 'Electric Love - Oliver Remix')]);
      return new Error('unexpected ' + u.pathname);
    });
    const r = await client().tracksByArtist(lib, 'BØRNS');
    expect(r.map((t) => t.title)).toEqual(['Electric Love - Oliver Remix']);
    expect(calls.some((u) => u.pathname === '/library/metadata/51/allLeaves')).toBe(false);
  });

  it('retries with an ASCII-folded name when the exact name finds nothing', async () => {
    stub((u) => {
      if (u.pathname.endsWith('/search')) {
        return u.searchParams.get('query') === 'BORNS' ? container([{ ratingKey: '50', title: 'BØRNS' }]) : container([]);
      }
      return container([meta('9', 'Song')]);
    });
    expect(await client().tracksByArtist(lib, 'BØRNS')).toHaveLength(1);
  });

  it('returns nothing for an empty name', async () => {
    stub(() => container([]));
    expect(await client().tracksByArtist(lib, '')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('PlexClient.rootOf', () => {
  it('returns the library folder as Plex sees it', () => {
    expect(PlexClient.rootOf(lib)).toBe('/data/Music');
    expect(PlexClient.rootOf({ ...lib, Location: undefined })).toBeNull();
  });
});

describe('PlexClient playlist writes', () => {
  const uri = (u: URL) => u.searchParams.get('uri')!;

  it('creates a playlist, chunking large lists across create + append calls', async () => {
    const created: URL[] = [];
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const u = new URL(input.toString());
      calls.push(u);
      const method = init?.method ?? 'GET';
      if (u.pathname === '/') return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: 'MACHINE' } }));
      if (method === 'POST' && u.pathname === '/playlists') {
        created.push(u);
        return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: '777' }] } }));
      }
      if (method === 'PUT' && u.pathname === '/playlists/777/items') return new Response('');
      return new Response('unexpected', { status: 500 });
    });
    const keys = Array.from({ length: 250 }, (_, i) => String(1000 + i));
    const id = await client().createPlaylist('EDM 🎧', keys);
    expect(id).toBe('777');
    expect(created[0]!.searchParams.get('title')).toBe('EDM 🎧');
    expect(created[0]!.searchParams.get('type')).toBe('audio');
    expect(created[0]!.searchParams.get('smart')).toBe('0');
    expect(uri(created[0]!)).toBe(`server://MACHINE/com.plexapp.plugins.library/library/metadata/${keys.slice(0, 100).join(',')}`);
    const puts = calls.filter((u) => u.pathname === '/playlists/777/items');
    expect(puts).toHaveLength(2);
    expect(uri(puts[0]!).endsWith(keys.slice(100, 200).join(','))).toBe(true);
    expect(uri(puts[1]!).endsWith(keys.slice(200).join(','))).toBe(true);
    expect(calls.every((u) => !u.toString().includes('TOKEN'))).toBe(true);
  });

  it('replaceItems clears first, then appends in order', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const u = new URL(input.toString());
      if (u.pathname === '/') return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: 'M' } }));
      seen.push(`${init?.method} ${u.pathname}`);
      return new Response('');
    });
    await client().replaceItems('5', ['1', '2']);
    expect(seen).toEqual(['DELETE /playlists/5/items', 'PUT /playlists/5/items']);
  });

  it('lists audio playlists and reads items with paging', async () => {
    stub((u) => {
      if (u.pathname === '/playlists') return container([{ ratingKey: '5', title: 'EDM' }]);
      return container([{ ratingKey: '10' }, { ratingKey: '11' }]);
    });
    expect(await client().listPlaylists()).toEqual([{ id: '5', title: 'EDM' }]);
    expect(await client().playlistItems('5')).toEqual(['10', '11']);
    expect(calls[0]!.searchParams.get('playlistType')).toBe('audio');
  });
});

describe('PlexClient.scan', () => {
  function methods(handler: (method: string, u: URL) => number) {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
      const u = new URL(input.toString());
      const method = init?.method ?? 'GET';
      seen.push(`${method} ${u.pathname}${u.searchParams.get('path') ? ' path=' + u.searchParams.get('path') : ''}`);
      return new Response('', { status: handler(method, u) });
    });
    return seen;
  }

  it('uses the documented POST with the folder path', async () => {
    const seen = methods(() => 200);
    await client().scan(lib, '/data/Music/BØRNS/Album');
    expect(seen).toEqual(['POST /library/sections/7/refresh path=/data/Music/BØRNS/Album']);
  });

  it('falls back to GET when the server rejects POST', async () => {
    const seen = methods((m) => (m === 'POST' ? 405 : 200));
    await client().scan(lib, '/data/Music/X');
    expect(seen).toEqual(['POST /library/sections/7/refresh path=/data/Music/X', 'GET /library/sections/7/refresh path=/data/Music/X']);
  });

  it('does not retry on other errors, and scans the whole section without a path', async () => {
    methods(() => 401);
    await expect(client().scan(lib)).rejects.toThrow(/401/);
    const seen = methods(() => 200);
    await client().scan(lib);
    expect(seen).toEqual(['POST /library/sections/7/refresh']);
  });
});
