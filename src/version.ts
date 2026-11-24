import { readFileSync } from 'node:fs';

/** Version from package.json (one level above src/ or dist/). */
export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();
