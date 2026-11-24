/** Sleep that resolves early (without throwing) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "30m" / "6h" / "1d" into milliseconds. */
export function parseInterval(text: string): number {
  const m = /^(\d+)([smhd])$/.exec(text);
  if (!m) throw new Error(`Invalid interval "${text}" (use e.g. 30m, 6h, 1d)`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

/** Make a string safe to use as ONE path component (no separators, no traversal, no reserved chars). */
export function sanitizeSegment(input: string, max = 120): string {
  let out = input
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (out.length > max) out = out.slice(0, max).trim().replace(/[. ]+$/, '');
  return out || '_';
}

/** Sliding-window limiter: at most `perMinute` takes in any window (default 60 s). */
export class RateLimiter {
  private stamps: number[] = [];

  constructor(private perMinute: number, private windowMs = 60_000, private now: () => number = Date.now) {}

  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(t);
        return;
      }
      if (signal?.aborted) return;
      await sleep(this.stamps[0]! + this.windowMs - t + 5, signal);
    }
  }
}
