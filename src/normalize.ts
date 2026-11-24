const BRACKET_NOISE =
  /[([][^)\]]*\b(remaster(?:ed)?|feat\.?|ft\.?|featuring|with|mono|stereo|deluxe|bonus track|\d{4} version|single version|radio edit)\b[^)\]]*[)\]]/gi;
const DASH_NOISE = [
  / - (?:\d{4} )?remaster(?:ed)?(?: \d{4})?.*$/i,
  / - (?:single|mono|stereo|album|radio) (?:version|edit)$/i,
  / - (?:feat\.?|ft\.?|featuring|with) .*$/i,
];

/**
 * Normalize a track title for comparison. Strips remaster/feature/version noise but keeps
 * things that change the song itself (live, acoustic, remix).
 */
export function normalizeTitle(input: string): string {
  let s = input.normalize('NFKD').replace(/\p{M}/gu, '');
  s = s.replace(BRACKET_NOISE, ' ');
  for (const re of DASH_NOISE) s = s.replace(re, '');
  return squash(s);
}

export function normalizeArtist(input: string): string {
  let s = input.normalize('NFKD').replace(/\p{M}/gu, '');
  s = s.replace(/^the\s+/i, '');
  return squash(s);
}

function squash(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function bigrams(s: string): Map<string, number> {
  const t = s.replace(/ /g, '');
  const m = new Map<string, number>();
  if (t.length < 2) {
    if (t) m.set(t, 1);
    return m;
  }
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity of two already-normalized strings, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return a === '' ? 0 : 1;
  const ma = bigrams(a);
  const mb = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const v of ma.values()) total += v;
  for (const v of mb.values()) total += v;
  if (total === 0) return 0;
  for (const [g, c] of ma) overlap += Math.min(c, mb.get(g) ?? 0);
  return (2 * overlap) / total;
}

/**
 * Words that mark a different recording of the same song (remix, live, bass boosted...).
 * Two titles that differ in these are different songs even when the rest is identical.
 */
const VERSION_WORDS =
  /\b(remix|live|acoustic|instrumental|karaoke|cover|sped up|slowed|reverb|nightcore|bass boosted|extended|demo|mashup|vip|bootleg|rework|flip|a cappella|acapella|orchestral|unplugged|lofi|8 bit)\b/g;

/** Sorted, de-duplicated version words found in an already-normalized title, joined by "|". */
export function versionTags(normalizedTitle: string): string {
  return [...new Set(normalizedTitle.match(VERSION_WORDS) ?? [])].sort().join('|');
}
