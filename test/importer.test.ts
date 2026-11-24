import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destinationFor, moveInto } from '../src/importer.js';
import type { TrackRec } from '../src/types.js';

const track = (over: Partial<TrackRec> = {}): TrackRec => ({
  id: 'abc', title: 'Song', artists: ['Artist'], album: 'Album', durationMs: 1000, isrc: null, trackNo: 3, ...over,
});

describe('destinationFor', () => {
  it('builds Artist/Album/NN - Title.ext', () => {
    const d = destinationFor('/music', track(), '.MP3');
    expect(d.file).toBe(resolve('/music/Artist/Album/03 - Song.mp3'));
  });
  it('contains hostile metadata inside the music dir', () => {
    const d = destinationFor('/music', track({ artists: ['../../etc'], album: '../x', title: '../../passwd' }), '.mp3');
    expect(d.file.startsWith(resolve('/music') + sep)).toBe(true);
    expect(d.file.split(sep)).not.toContain('..');
  });
  it('rejects unexpected extensions', () => {
    expect(() => destinationFor('/music', track(), '.exe')).toThrow();
    expect(() => destinationFor('/music', track(), '.zip')).toThrow();
  });
  it('omits the number when unknown', () => {
    expect(destinationFor('/music', track({ trackNo: null }), '.flac').file.endsWith('/Song.flac')).toBe(true);
  });
});

describe('moveInto', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'imp-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('moves and creates folders', async () => {
    writeFileSync(join(dir, 'src.mp3'), 'data');
    expect(await moveInto(join(dir, 'src.mp3'), join(dir, 'a/b/out.mp3'))).toBe('moved');
    expect(readFileSync(join(dir, 'a/b/out.mp3'), 'utf8')).toBe('data');
    expect(existsSync(join(dir, 'src.mp3'))).toBe(false);
  });
  it('never overwrites an existing file', async () => {
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a/out.mp3'), 'original');
    writeFileSync(join(dir, 'src.mp3'), 'new');
    expect(await moveInto(join(dir, 'src.mp3'), join(dir, 'a/out.mp3'))).toBe('exists');
    expect(readFileSync(join(dir, 'a/out.mp3'), 'utf8')).toBe('original');
  });
});
