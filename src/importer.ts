import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { sanitizeSegment } from './util.js';
import type { TrackRec } from './types.js';

const ALLOWED_EXT = new Set(['.mp3', '.flac', '.ogg', '.wav']);

/** Library path for a track: <musicDir>/<Artist>/<Album>/<NN - >Title.ext. Never escapes musicDir. */
export function destinationFor(musicDir: string, track: TrackRec, ext: string): { dir: string; file: string } {
  const e = ext.toLowerCase();
  if (!ALLOWED_EXT.has(e)) throw new Error(`Unsupported audio extension "${ext}"`);
  const artist = sanitizeSegment(track.artists[0] ?? 'Unknown Artist');
  const album = sanitizeSegment(track.album || 'Unknown Album');
  const nn = track.trackNo ? `${String(track.trackNo).padStart(2, '0')} - ` : '';
  const dir = resolve(musicDir, artist, album);
  const file = join(dir, `${nn}${sanitizeSegment(track.title, 100)}${e}`);
  if (!file.startsWith(resolve(musicDir) + sep)) throw new Error('Refusing to write outside the music directory');
  return { dir, file };
}

export function extensionOf(path: string): string {
  return extname(path).toLowerCase();
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** Move a staged file into the library without overwriting. Returns whether a move happened. */
export async function moveInto(src: string, destFile: string): Promise<'moved' | 'exists'> {
  await mkdir(dirname(destFile), { recursive: true, mode: 0o775 });
  if (await exists(destFile)) {
    await rm(src, { force: true });
    return 'exists';
  }
  try {
    await rename(src, destFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(src, destFile);
    await rm(src, { force: true });
  }
  return 'moved';
}
