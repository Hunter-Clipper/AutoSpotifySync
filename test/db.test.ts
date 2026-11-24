import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import type { LibrarySnapshot, TrackRec } from '../src/types.js';

const track = (id: string): TrackRec => ({
  id, title: `T${id}`, artists: ['A'], album: 'Al', durationMs: 1000, isrc: null, trackNo: 1,
});
const snap = (ids: string[], collId = 'c1', failed: string[] = []): LibrarySnapshot => ({
  mode: 'full',
  tracks: new Map(ids.map((i) => [i, track(i)])),
  collections: [{ id: collId, name: 'List', kind: 'playlist-own', trackIds: ids }],
  failedCollectionIds: failed,
});

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ass-'));
  store = new Store(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Store', () => {
  it('saves a snapshot and reports counts', () => {
    store.saveSnapshot(snap(['1', '2']));
    expect(store.counts()).toEqual({ discovered: 2 });
    expect(store.collectionCount()).toBe(1);
  });

  it('applies matches and lists by status', () => {
    store.saveSnapshot(snap(['1', '2']));
    store.applyMatches([
      { id: '1', status: 'matched', confidence: 1, plexKey: 'k' },
      { id: '2', status: 'missing', confidence: 0.1, plexKey: null },
    ]);
    expect(store.list('missing', 10).map((r) => r.id)).toEqual(['2']);
  });

  it('does not re-check tracks past the Plex stage', () => {
    store.saveSnapshot(snap(['1']));
    store.applyMatches([{ id: '1', status: 'missing', confidence: 0, plexKey: null }]);
    expect(store.tracksToMatch()).toHaveLength(1);
  });

  it('preserves status when a track is re-synced', () => {
    store.saveSnapshot(snap(['1']));
    store.applyMatches([{ id: '1', status: 'matched', confidence: 1, plexKey: 'k' }]);
    store.saveSnapshot(snap(['1']));
    expect(store.counts()).toEqual({ matched: 1 });
  });

  it('drops vanished collections but keeps ones that failed to fetch', () => {
    store.saveSnapshot(snap(['1'], 'old'));
    store.saveSnapshot(snap(['1'], 'new', ['old']));
    expect(store.collectionCount()).toBe(2);
    store.saveSnapshot(snap(['1'], 'new'));
    expect(store.collectionCount()).toBe(1);
  });
});
