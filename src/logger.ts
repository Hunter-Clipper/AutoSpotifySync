const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const secrets = new Set<string>();

/** Register a value (token, key, secret) that must never appear in log output. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

/** Replace every registered secret in a string with `***`. */
export function scrub(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const min = LEVELS[level];
  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    let line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    if (meta && Object.keys(meta).length > 0) {
      line += ` ${JSON.stringify(meta, (_k, v) => (v instanceof Error ? v.message : v))}`;
    }
    const out = scrub(line);
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(out);
  };
  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}
