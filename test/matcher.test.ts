import { describe, expect, it } from 'vitest';
import { PlexIndex } from '../src/matcher.js';
import type { PlexTrack, TrackRec } from '../src/types.js';

const plex = (title: string, artist: string, album = 'Album', trackArtist: string | null = null): PlexTrack => ({
  key: `${artist}|${title}|${album}`, title, artist, trackArtist, album,
});
const sp = (title: string, artists: string[], album = 'Album'): TrackRec => ({
  id: title, title, artists, album, durationMs: 200000, isrc: null, trackNo: 1,
});
const opts = { minConfidence: 0.85, strictAlbum: false };

describe('PlexIndex.match', () => {
  const index = new PlexIndex([
    plex('Come Together', 'The Beatles', 'Abbey Road'),
    plex('Halo', 'Beyoncé', 'I Am... Sasha Fierce'),
    plex('Intro', 'Some Other Band'),
    plex('Collab Song', 'Various Artists', 'Compilation', 'Real Artist'),
  ]);

  it('matches the same song on a different release (remaster)', () => {
    const r = index.match(sp('Come Together - Remastered 2009', ['The Beatles'], 'Abbey Road (Remastered)'), opts);
    expect(r.status).toBe('matched');
  });

  it('matches through diacritics', () => {
    expect(index.match(sp('Halo', ['Beyonce']), opts).status).toBe('matched');
  });

  it('matches via the per-track artist on compilations', () => {
    expect(index.match(sp('Collab Song', ['Real Artist']), opts).status).toBe('matched');
  });

  it('does not match same title by a different artist', () => {
    expect(index.match(sp('Intro', ['Totally Different']), opts).status).toBe('missing');
  });

  it('reports missing for unknown songs', () => {
    const r = index.match(sp('Nonexistent', ['The Beatles']), opts);
    expect(r.status).toBe('missing');
    expect(r.plexKey).toBeNull();
  });

  it('sends near matches to review', () => {
    const r = index.match(sp('Come Togethr', ['The Beatles']), { ...opts, minConfidence: 0.99 });
    expect(r.status).toBe('review');
  });

  it('strict album mode rejects a different album', () => {
    const r = index.match(sp('Come Together', ['The Beatles'], 'Greatest Hits'), { ...opts, strictAlbum: true });
    expect(r.status).toBe('missing');
  });
});
