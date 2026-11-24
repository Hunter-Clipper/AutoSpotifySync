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
