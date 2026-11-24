import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Simulate staging and the music share being different filesystems: rename() fails with EXDEV
// for any move out of the staging folder, exactly as on Unraid.
const state = vi.hoisted(() => ({ failCopyAfterBytes: -1 }));

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (String(from).includes('staging')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      return real.rename(from, to);
    },
    copyFile: async (from: string, to: string) => {
      if (state.failCopyAfterBytes >= 0) {
        // crash mid-copy: some bytes land at the destination, then the process "dies"
        writeFileSync(to, readFileSync(from).subarray(0, state.failCopyAfterBytes));
        throw new Error('container killed mid-copy');
      }
      return real.copyFile(from, to);
    },
  };
});

const { moveInto } = await import('../src/importer.js');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xdev-'));
  state.failCopyAfterBytes = -1;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stage(content = 'full-audio-file') {
  const staging = join(dir, 'staging');
  rmSync(staging, { recursive: true, force: true });
  require_mkdir(staging);
  const src = join(staging, 'a.mp3');
  writeFileSync(src, content);
  return src;
}
import { mkdirSync } from 'node:fs';
const require_mkdir = (p: string) => mkdirSync(p, { recursive: true });

describe('moveInto across filesystems (EXDEV)', () => {
  it('copies via a temporary name and leaves no .part file behind', async () => {
    const src = stage();
    const dest = join(dir, 'music/A/B/01 - T.mp3');
    expect(await moveInto(src, dest)).toBe('moved');
    expect(readFileSync(dest, 'utf8')).toBe('full-audio-file');
    expect(existsSync(src)).toBe(false);
    expect(readdirSync(join(dir, 'music/A/B'))).toEqual(['01 - T.mp3']);
  });

  it('a crash mid-copy never leaves a truncated file at the final name, and the source survives', async () => {
    const src = stage();
    const dest = join(dir, 'music/A/B/01 - T.mp3');
    state.failCopyAfterBytes = 4;
    await expect(moveInto(src, dest)).rejects.toThrow(/killed mid-copy/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('retrying after that crash completes the import correctly', async () => {
    const src = stage();
    const dest = join(dir, 'music/A/B/01 - T.mp3');
    state.failCopyAfterBytes = 4;
    await expect(moveInto(src, dest)).rejects.toThrow();
    state.failCopyAfterBytes = -1;
    expect(await moveInto(src, dest)).toBe('moved');
    expect(readFileSync(dest, 'utf8')).toBe('full-audio-file');
  });

  it('clears a stale .part left by a hard kill (no chance to clean up) before copying', async () => {
    const src = stage();
    const dest = join(dir, 'music/A/B/01 - T.mp3');
    mkdirSync(join(dir, 'music/A/B'), { recursive: true });
    writeFileSync(`${dest}.part`, 'half');
    expect(await moveInto(src, dest)).toBe('moved');
    expect(readFileSync(dest, 'utf8')).toBe('full-audio-file');
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});
