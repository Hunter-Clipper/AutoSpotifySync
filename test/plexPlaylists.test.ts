import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import type { PlexPlaylistApi } from '../src/plex.js';
import { syncPlexPlaylists } from '../src/plexPlaylists.js';
import type { CollectionRec, LibrarySnapshot, TrackRec } from '../src/types.js';

const log = createLogger('error');

class FakePlex implements PlexPlaylistApi {
  lists = new Map<string, { title: string; items: string[] }>();
  calls: string[] = [];
  next = 100;
  failFor?: string;
  async listPlaylists() {
    return [...this.lists].map(([id, p]) => ({ id, title: p.title }));
  }
  async playlistItems(id: string) {
    return [...this.lists.get(id)!.items];
  }
  async createPlaylist(title: string, keys: string[]) {
    if (title === this.failFor) throw new Error('plex exploded');
    const id = String(this.next++);
    this.lists.set(id, { title, items: [...keys] });
    this.calls.push(`create:${title}`);
    return id;
  }
  async replaceItems(id: string, keys: string[]) {
    this.lists.get(id)!.items = [...keys];
    this.calls.push(`replace:${id}`);
  }
  async renamePlaylist(id: string, title: string) {
    this.lists.get(id)!.title = title;
    this.calls.push(`rename:${id}`);
  }
  async deletePlaylist(id: string) {
    this.lists.delete(id);
    this.calls.push(`delete:${id}`);
  }
}

const trk = (id: string): TrackRec => ({ id, title: id, artists: ['A'], album: 'Al', durationMs: 1000, isrc: null, trackNo: 1 });
const coll = (id: string, name: string, kind: CollectionRec['kind'], trackIds: string[]): CollectionRec => ({ id, name, kind, trackIds });

let dir: string;
let store: Store;
let plex: FakePlex;
const opts = { dryRun: false, deleteRemoved: true };

/** Load collections and mark which tracks are in Plex (key = "k" + id). */
function load(collections: CollectionRec[], inPlex: string[]) {
  const ids = [...new Set(collections.flatMap((c) => c.trackIds))];
  const snap: LibrarySnapshot = { mode: 'full', tracks: new Map(ids.map((i) => [i, trk(i)])), collections, failedCollectionIds: [] };
  store.saveSnapshot(snap);
  store.applyMatches(ids.map((id) => (inPlex.includes(id)
    ? { id, status: 'matched' as const, confidence: 1, plexKey: `k${id}` }
    : { id, status: 'missing' as const, confidence: 0, plexKey: null })));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pl-'));
  store = new Store(dir);
  plex = new FakePlex();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('syncPlexPlaylists', () => {
  it('creates playlists with exact Spotify names, only tracks in Plex, in Spotify order; Liked Songs too', async () => {
    load([coll('p1', 'EDM', 'playlist-own', ['c', 'a', 'x', 'b']), coll('liked', 'Liked Songs', 'liked', ['a'])], ['a', 'b', 'c']);
    const s = await syncPlexPlaylists(store, plex, log, opts);
    expect(s.created).toBe(2);
    const titles = [...plex.lists.values()].map((p) => p.title).sort();
    expect(titles).toEqual(['EDM', 'Liked Songs']);
    const edm = [...plex.lists.values()].find((p) => p.title === 'EDM')!;
    expect(edm.items).toEqual(['kc', 'ka', 'kb']);
  });

  it('does not mirror saved albums', async () => {
    load([coll('album:1', 'Some Album', 'album', ['a'])], ['a']);
    expect((await syncPlexPlaylists(store, plex, log, opts)).created).toBe(0);
    expect(plex.lists.size).toBe(0);
  });

  it('is a no-op when nothing changed, and updates when new tracks arrive', async () => {
    load([coll('p1', 'EDM', 'playlist-own', ['a', 'b'])], ['a']);
    await syncPlexPlaylists(store, plex, log, opts);
    plex.calls = [];
    expect((await syncPlexPlaylists(store, plex, log, opts)).unchanged).toBe(1);
    expect(plex.calls).toEqual([]);
    store.applyMatches([{ id: 'b', status: 'matched', confidence: 1, plexKey: 'kb' }]);
    const s = await syncPlexPlaylists(store, plex, log, opts);
    expect(s.updated).toBe(1);
    expect([...plex.lists.values()][0]!.items).toEqual(['ka', 'kb']);
  });

  it('follows a Spotify rename and a reorder', async () => {
    load([coll('p1', 'Old', 'playlist-own', ['a', 'b'])], ['a', 'b']);
    await syncPlexPlaylists(store, plex, log, opts);
    load([coll('p1', 'New', 'playlist-own', ['b', 'a'])], ['a', 'b']);
    const s = await syncPlexPlaylists(store, plex, log, opts);
    expect(s.updated).toBe(1);
    const p = [...plex.lists.values()][0]!;
    expect(p.title).toBe('New');
    expect(p.items).toEqual(['kb', 'ka']);
    expect(plex.lists.size).toBe(1);
  });

  it('does not create empty playlists', async () => {
    load([coll('p1', 'Nothing yet', 'playlist-own', ['x'])], []);
    const s = await syncPlexPlaylists(store, plex, log, opts);
    expect(s.skipped).toBe(1);
    expect(plex.lists.size).toBe(0);
  });

  it('never touches a same-named playlist it did not create', async () => {
    plex.lists.set('900', { title: 'EDM', items: ['mine'] });
    load([coll('p1', 'EDM', 'playlist-own', ['a'])], ['a']);
    const s = await syncPlexPlaylists(store, plex, log, opts);
    expect(s.skipped).toBe(1);
    expect(plex.lists.get('900')!.items).toEqual(['mine']);
    expect(plex.lists.size).toBe(1);
  });

  it('recreates a playlist the user deleted in Plex', async () => {
    load([coll('p1', 'EDM', 'playlist-own', ['a'])], ['a']);
    await syncPlexPlaylists(store, plex, log, opts);
    plex.lists.clear();
    expect((await syncPlexPlaylists(store, plex, log, opts)).created).toBe(1);
    expect(plex.lists.size).toBe(1);
  });

  it('deletes playlists whose Spotify source is gone, only ours', async () => {
    plex.lists.set('900', { title: 'Hand made', items: [] });
    load([coll('p1', 'EDM', 'playlist-own', ['a']), coll('p2', 'Old', 'playlist-own', ['a'])], ['a']);
    await syncPlexPlaylists(store, plex, log, opts);
    load([coll('p1', 'EDM', 'playlist-own', ['a'])], ['a']);
    const s = await syncPlexPlaylists(store, plex, log, opts);
    expect(s.deleted).toBe(1);
    expect([...plex.lists.values()].map((p) => p.title).sort()).toEqual(['EDM', 'Hand made']);
  });

  it('keeps the Plex copy when deletion is disabled', async () => {
    load([coll('p2', 'Old', 'playlist-own', ['a'])], ['a']);
    await syncPlexPlaylists(store, plex, log, opts);
    store.saveSnapshot({ mode: 'full', tracks: new Map(), collections: [], failedCollectionIds: [] });
    const s = await syncPlexPlaylists(store, plex, log, { ...opts, deleteRemoved: false });
    expect(s.deleted).toBe(0);
    expect(plex.lists.size).toBe(1);
  });

  it('dry run reports changes but writes nothing', async () => {
    load([coll('p1', 'EDM', 'playlist-own', ['a'])], ['a']);
    const s = await syncPlexPlaylists(store, plex, log, { ...opts, dryRun: true });
    expect(s.created).toBe(1);
    expect(s.dryRun).toBe(true);
    expect(plex.calls).toEqual([]);
    expect(store.plexPlaylists().size).toBe(0);
  });

  it('one failing playlist does not stop the others', async () => {
    load([coll('p1', 'Bad', 'playlist-own', ['a']), coll('p2', 'Good', 'playlist-own', ['a'])], ['a']);
    plex.failFor = 'Bad';
    const s = await syncPlexPlaylists(store, plex, log, opts);
    expect(s.errors).toBe(1);
    expect(s.created).toBe(1);
    expect([...plex.lists.values()].map((p) => p.title)).toEqual(['Good']);
  });

  it('handles a blank Spotify playlist name', async () => {
    load([coll('p1', '  ', 'playlist-own', ['a'])], ['a']);
    await syncPlexPlaylists(store, plex, log, opts);
    expect([...plex.lists.values()][0]!.title).toBe('Untitled Spotify playlist');
  });
});
