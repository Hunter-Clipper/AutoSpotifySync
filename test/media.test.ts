import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFile } from 'music-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realMedia } from '../src/media.js';
import type { TrackRec } from '../src/types.js';

const track: TrackRec = {
  id: 'x', title: 'Hello', artists: ['Band A', 'Band B'], album: 'LP', durationMs: 12000, isrc: 'USABC1234567', trackNo: 4,
};

let dir: string;
let mp3: string;
let haveFfmpeg = false;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'media-'));
  mp3 = join(dir, 't.mp3');
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-b:a', '128k', mp3]);
  haveFfmpeg = r.status === 0;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('realMedia (needs ffmpeg)', () => {
  it('accepts a good file and rejects a wrong duration', ({ skip }) => {
    if (!haveFfmpeg) skip();
    return (async () => {
      expect((await realMedia.check(mp3, track, 5, false)).ok).toBe(true);
      const bad = await realMedia.check(mp3, { ...track, durationMs: 180000 }, 5, false);
      expect(bad.ok).toBe(false);
      expect(bad.reason).toMatch(/duration/);
    })();
  });

  it('rejects tiny and unreadable files', async () => {
    const tiny = join(dir, 'tiny.mp3');
    writeFileSync(tiny, 'x'.repeat(100));
    expect((await realMedia.check(tiny, track, 5, false)).reason).toMatch(/too small/);
    const junk = join(dir, 'junk.mp3');
    writeFileSync(junk, Buffer.alloc(60_000, 7));
    expect((await realMedia.check(junk, track, 5, false)).ok).toBe(false);
  });

  it('writes canonical tags that read back correctly', ({ skip }) => {
    if (!haveFfmpeg) skip();
    return (async () => {
      expect((await realMedia.check(mp3, track, 5, true)).reason).toMatch(/tags/);
      await realMedia.writeTags(mp3, track);
      const m = await parseFile(mp3);
      expect(m.common.title).toBe('Hello');
      expect(m.common.artist).toBe('Band A, Band B');
      expect(m.common.albumartist).toBe('Band A');
      expect(m.common.album).toBe('LP');
      expect(m.common.track.no).toBe(4);
      expect(m.common.isrc).toEqual(['USABC1234567']);
      expect((await realMedia.check(mp3, track, 5, true)).ok).toBe(true);
    })();
  });
});
