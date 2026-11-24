import { describe, expect, it } from 'vitest';
import { parseInterval, RateLimiter, sanitizeSegment, sleep } from '../src/util.js';

describe('parseInterval', () => {
  it('parses units', () => {
    expect(parseInterval('30s')).toBe(30_000);
    expect(parseInterval('6h')).toBe(21_600_000);
    expect(parseInterval('1d')).toBe(86_400_000);
  });
  it('rejects junk', () => {
    expect(() => parseInterval('6 hours')).toThrow();
    expect(() => parseInterval('')).toThrow();
  });
});

describe('sanitizeSegment', () => {
  it.each([
    ['AC/DC', 'AC_DC'],
    ['..', '_'],
    ['../../etc/passwd', '_.._etc_passwd'],
    ['What?', 'What_'],
    ['  spaced   out  ', 'spaced out'],
    ['trailing dots...', 'trailing dots'],
    ['.hidden', 'hidden'],
    ['', '_'],
    ['a\u0000b\nc', 'abc'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeSegment(input)).toBe(expected);
  });
  it('never contains a separator or traversal', () => {
    for (const evil of ['..\\..\\x', '/abs/path', 'a/../b', 'C:\\Windows']) {
      const out = sanitizeSegment(evil);
      expect(out).not.toMatch(/[\\/]/);
      expect(out).not.toBe('..');
    }
  });
  it('truncates long names', () => {
    expect(sanitizeSegment('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('RateLimiter', () => {
  it('allows N takes immediately, then makes the next wait for the window', async () => {
    const rl = new RateLimiter(2, 150);
    const t0 = Date.now();
    await rl.take();
    await rl.take();
    expect(Date.now() - t0).toBeLessThan(100);
    await rl.take();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });
});

describe('sleep', () => {
  it('resolves early on abort', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
