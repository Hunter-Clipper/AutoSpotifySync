import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Config } from './config.js';
import { registerSecret } from './logger.js';

export const SCOPES = ['user-library-read', 'playlist-read-private', 'playlist-read-collaborative'];
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/callback';

export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL('https://accounts.spotify.com/authorize');
  u.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    show_dialog: 'true',
  }).toString();
  return u.toString();
}

/** Pull the authorization code out of the URL the browser was redirected to, checking `state`. */
export function parseRedirect(pasted: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error('That is not a valid URL. Paste the full address from the browser address bar.');
  }
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Spotify reported an error: ${error}`);
  if (url.searchParams.get('state') !== expectedState) {
    throw new Error('State mismatch: this URL is not from the login started by this command. Run `auth` again.');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('No authorization code found in that URL.');
  return code;
}

export async function exchangeCode(cfg: Config, code: string, redirectUri: string): Promise<string> {
  const basic = Buffer.from(`${cfg.SPOTIFY_CLIENT_ID}:${cfg.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Spotify rejected the code (HTTP ${res.status}): ${detail}. Codes are single-use and expire quickly; run \`auth\` again.`);
  }
  const json = (await res.json()) as { refresh_token?: string; scope?: string };
  if (!json.refresh_token) throw new Error('Spotify did not return a refresh token.');
  registerSecret(json.refresh_token);
  return json.refresh_token;
}

export async function runAuth(cfg: Config): Promise<void> {
  const redirectUri = cfg.SPOTIFY_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
  const state = randomBytes(16).toString('hex');
  console.log(`Make sure this redirect URI is registered in your Spotify app settings:\n  ${redirectUri}\n`);
  console.log('1. Open this URL in any browser and approve access:\n');
  console.log(`   ${buildAuthUrl(cfg.SPOTIFY_CLIENT_ID, redirectUri, state)}\n`);
  console.log('2. The browser will then fail to load the redirect page. That is expected.');
  console.log('   Copy the FULL address from the address bar and paste it here.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let pasted: string;
  try {
    pasted = await rl.question('Redirect URL: ');
  } finally {
    rl.close();
  }
  const token = await exchangeCode(cfg, parseRedirect(pasted, state), redirectUri);
  console.log('\nSuccess. Set this in your environment (keep it secret, never commit it):\n');
  console.log(`SPOTIFY_REFRESH_TOKEN=${token}\n`);
}
