import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runPlaylistSync } from '../src/daemon.js';
import { Store } from '../src/db.js';
import { createLogger } from '../src/logger.js';

const base = { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret-value', PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 'plex-token-value' };
let dir: string;
let store: Store;
let writes: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-'));
  store = new Store(dir);
  store.saveSnapshot({
    mode: 'full',
    tracks: new Map([['a', { id: 'a', title: 'A', artists: ['X'], album: 'Al', durationMs: 1, isrc: null, trackNo: 1 }]]),
    collections: [{ id: 'p1', name: 'EDM', kind: 'playlist-own', trackIds: ['a'] }],
    failedCollectionIds: [],
  });
  store.applyMatches([{ id: 'a', status: 'matched', confidence: 1, plexKey: 'k1' }]);
  writes = [];
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const u = new URL(input.toString());
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push(`${method} ${u.pathname}`);
    if (u.pathname === '/') return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: 'M' } }));
    if (u.pathname === '/playlists' && method === 'GET') return new Response(JSON.stringify({ MediaContainer: { Metadata: [] } }));
    if (u.pathname === '/playlists' && method === 'POST') {
      return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: '55' }] } }));
    }
    return new Response('');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (env: Record<string, string>) => runPlaylistSync(loadConfig({ ...base, ...env }), store, createLogger('error'));

describe('runPlaylistSync', () => {
  it('does nothing unless PLEX_SYNC_PLAYLISTS is on', async () => {
    expect(await run({ DRY_RUN: 'false' })).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it('writes to Plex when on and not in any dry run', async () => {
    const s = await run({ PLEX_SYNC_PLAYLISTS: 'true', DRY_RUN: 'false' });
    expect(s?.created).toBe(1);
    expect(writes).toEqual(['POST /playlists']);
  });

  it('PLEX_PLAYLISTS_DRY_RUN previews only, even with global DRY_RUN off', async () => {
    const s = await run({ PLEX_SYNC_PLAYLISTS: 'true', DRY_RUN: 'false', PLEX_PLAYLISTS_DRY_RUN: 'true' });
    expect(s).toMatchObject({ created: 1, dryRun: true });
    expect(writes).toEqual([]);
    expect(store.plexPlaylists().size).toBe(0);
  });

  it('global DRY_RUN also previews', async () => {
    const s = await run({ PLEX_SYNC_PLAYLISTS: 'true', DRY_RUN: 'true' });
    expect(s?.dryRun).toBe(true);
    expect(writes).toEqual([]);
  });
});
