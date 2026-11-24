import { describe, expect, it } from 'vitest';
import { configWarnings, loadConfig, playlistMode } from '../src/config.js';

const base = { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret-value' };

describe('loadConfig whitespace tolerance', () => {
  it('trims stray whitespace in names and values', () => {
    const cfg = loadConfig({ ...base, 'PLEX_SYNC_PLAYLISTS ': 'true', DRY_RUN: ' false ' });
    expect(cfg.PLEX_SYNC_PLAYLISTS).toBe(true);
    expect(cfg.DRY_RUN).toBe(false);
  });
  it('treats blank values as unset (Unraid empty fields)', () => {
    expect(loadConfig({ ...base, PLEX_URL: '   ', DOWNLOAD_FORMAT: '' }).DOWNLOAD_FORMAT).toBe('mp3');
  });
  it('defaults are the safe ones', () => {
    const cfg = loadConfig(base);
    expect([cfg.AUTO_DOWNLOAD, cfg.DRY_RUN, cfg.PLEX_SYNC_PLAYLISTS, cfg.DURATION_TOLERANCE_SEC]).toEqual([false, true, false, 12]);
  });
});

describe('configWarnings', () => {
  it('flags stray whitespace in a name', () => {
    expect(configWarnings({ ...base, 'PLEX_SYNC_PLAYLISTS ': 'true' }).join('\n')).toMatch(/stray whitespace/);
  });
  it('suggests the right name for a typo', () => {
    const w = configWarnings({ ...base, PLEX_SYNC_PLAYLIST: 'true' });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('did you mean PLEX_SYNC_PLAYLISTS');
  });
  it('ignores unrelated variables and valid settings', () => {
    expect(configWarnings({ ...base, PATH: '/bin', HOME: '/root', NODE_VERSION: '24', PLEX_URL: 'http://x', LOG_LEVEL: 'info' })).toEqual([]);
  });
});

describe('playlistMode', () => {
  it('reports off, preview and on', () => {
    expect(playlistMode(loadConfig(base))).toBe('off');
    expect(playlistMode(loadConfig({ ...base, PLEX_SYNC_PLAYLISTS: 'true', DRY_RUN: 'false' }))).toBe('on');
    expect(playlistMode(loadConfig({ ...base, PLEX_SYNC_PLAYLISTS: 'true', DRY_RUN: 'false', PLEX_PLAYLISTS_DRY_RUN: 'true' }))).toBe('preview');
    expect(playlistMode(loadConfig({ ...base, PLEX_SYNC_PLAYLISTS: 'true' }))).toBe('preview');
  });
});
