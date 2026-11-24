import { z } from 'zod';
import { registerSecret } from './logger.js';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  // Spotify
  SPOTIFY_CLIENT_ID: z.string().min(1),
  SPOTIFY_CLIENT_SECRET: z.string().min(1),
  SPOTIFY_REFRESH_TOKEN: z.string().optional(),
  SPOTIFY_PLAYLIST_URLS: z.string().optional(),

  // Plex
  PLEX_URL: z.string().url().optional(),
  PLEX_TOKEN: z.string().optional(),
  PLEX_MUSIC_LIBRARY: z.string().optional(),

  // Downloader (used from milestone 4)
  DOWNLOADER_URL: z.string().url().optional(),
  DOWNLOADER_API_KEY: z.string().optional(),

  // Safety / behavior
  AUTO_DOWNLOAD: bool(false),
  DRY_RUN: bool(true),
  MAX_DOWNLOADS_PER_RUN: z.coerce.number().int().min(0).default(50),
  DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(2),
  DOWNLOAD_RATE_PER_MIN: z.coerce.number().int().min(1).max(10).default(8),
  DOWNLOAD_FORMAT: z.enum(['mp3', 'flac', 'wav', 'ogg']).default('mp3'),
  DOWNLOAD_BITRATE: z.enum(['128k', '192k', '256k', '320k']).default('320k'),
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  RETRY_COOLDOWN_DAYS: z.coerce.number().min(0).default(7),
  MATCH_STRICT_ALBUM: bool(false),
  MATCH_MIN_CONFIDENCE: z.coerce.number().min(0.5).max(1).default(0.85),
  DURATION_TOLERANCE_SEC: z.coerce.number().min(0).default(5),
  SYNC_INTERVAL: z
    .string()
    .regex(/^\d+[smhd]$/, 'use a number plus s/m/h/d, e.g. 6h')
    .default('6h'),
  NOTIFY_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CONFIG_DIR: z.string().default('./config'),
});

export type Config = ReturnType<typeof parse>;

function parse(env: NodeJS.ProcessEnv) {
  // Unraid templates pass unset fields as empty strings: treat them as unset.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  return schema.parse(cleaned);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let cfg: Config;
  try {
    cfg = parse(env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const lines = err.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
      throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
    }
    throw err;
  }
  for (const s of [
    cfg.SPOTIFY_CLIENT_SECRET,
    cfg.SPOTIFY_REFRESH_TOKEN,
    cfg.PLEX_TOKEN,
    cfg.DOWNLOADER_API_KEY,
  ]) {
    registerSecret(s);
  }
  return cfg;
}

/** Fail with a clear message if any of the named settings are missing. */
export function requireSettings<K extends keyof Config>(
  cfg: Config,
  keys: K[],
): asserts cfg is Config & { [P in K]-?: NonNullable<Config[P]> } {
  const missing = keys.filter((k) => cfg[k] === undefined);
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(', ')}`);
}
