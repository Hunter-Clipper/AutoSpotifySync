import { describe, expect, it } from 'vitest';
import { buildAuthUrl, parseRedirect, SCOPES } from '../src/auth.js';

describe('buildAuthUrl', () => {
  it('includes client, redirect, state and all scopes', () => {
    const u = new URL(buildAuthUrl('cid', 'http://127.0.0.1:8888/callback', 'st'));
    expect(u.origin + u.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8888/callback');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('scope')).toBe(SCOPES.join(' '));
  });
});

describe('parseRedirect', () => {
  const base = 'http://127.0.0.1:8888/callback';
  it('returns the code when state matches', () => {
    expect(parseRedirect(`${base}?code=abc&state=st`, 'st')).toBe('abc');
  });
  it('tolerates surrounding whitespace', () => {
    expect(parseRedirect(`  ${base}?code=abc&state=st\n`, 'st')).toBe('abc');
  });
  it('rejects a wrong state', () => {
    expect(() => parseRedirect(`${base}?code=abc&state=evil`, 'st')).toThrow(/State mismatch/);
  });
  it('surfaces Spotify errors', () => {
    expect(() => parseRedirect(`${base}?error=access_denied&state=st`, 'st')).toThrow(/access_denied/);
  });
  it('rejects missing code and non-URLs', () => {
    expect(() => parseRedirect(`${base}?state=st`, 'st')).toThrow(/No authorization code/);
    expect(() => parseRedirect('not a url', 'st')).toThrow(/not a valid URL/);
  });
});
