import { describe, expect, it } from 'vitest';
import { normalizeArtist, normalizeTitle, similarity, versionTags } from '../src/normalize.js';

describe('normalizeTitle', () => {
  it.each([
    ['Come Together - Remastered 2009', 'come together'],
    ['Come Together (Remastered 2009)', 'come together'],
    ['Under Pressure (feat. David Bowie)', 'under pressure'],
    ['Song - Single Version', 'song'],
    ['Beyoncé – Halo', 'beyonce halo'],
    ['Rock & Roll', 'rock and roll'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it('keeps versions that are different songs', () => {
    expect(normalizeTitle('Song (Live)')).toBe('song live');
    expect(normalizeTitle('Song (Acoustic)')).toBe('song acoustic');
    expect(normalizeTitle('Song (Remix)')).toBe('song remix');
  });
});

describe('normalizeArtist', () => {
  it('drops leading "the" and diacritics', () => {
    expect(normalizeArtist('The Beatles')).toBe('beatles');
    expect(normalizeArtist('Sigur Rós')).toBe('sigur ros');
  });
});

describe('similarity', () => {
  it('is 1 for identical, 0 for empty', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', '')).toBe(0);
  });
  it('ranks near strings above distant ones', () => {
    expect(similarity('hello world', 'hello wrld')).toBeGreaterThan(similarity('hello world', 'goodbye'));
  });
});

describe('versionTags', () => {
  it('finds version words, order-independent and de-duplicated', () => {
    expect(versionTags(normalizeTitle('Song (Bass Boosted) - Oliver Remix'))).toBe('bass boosted|remix');
    expect(versionTags(normalizeTitle('Song - Remix (Remix)'))).toBe('remix');
  });
  it('is empty for ordinary titles, including remasters and features', () => {
    expect(versionTags(normalizeTitle('Come Together - Remastered 2009'))).toBe('');
    expect(versionTags(normalizeTitle('Under Pressure (feat. David Bowie)'))).toBe('');
  });
});
