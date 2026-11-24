import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface JobStatus {
  job_id: string;
  status: 'running' | 'done' | 'failed' | string;
  error: string | null;
  filename: string | null;
  total?: number;
  completed?: number;
}

export type DownloaderErrorKind = 'busy' | 'network' | 'notfound' | 'auth' | 'http';

export class DownloaderError extends Error {
  constructor(message: string, readonly kind: DownloaderErrorKind, readonly status?: number) {
    super(message);
  }
  /** Worth retrying later without counting it as a failed attempt. */
  get transient(): boolean {
    return this.kind === 'busy' || this.kind === 'network';
  }
}

const MAX_FILE_BYTES = 500 * 1024 * 1024;

export interface DownloaderLike {
  createJob(spotifyTrackId: string, format: string, bitrate: string): Promise<JobStatus>;
  getJob(jobId: string): Promise<JobStatus>;
  fetchFile(jobId: string, destPath: string): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
}

/** Client for the spotify-downloader HTTP API (/api/v1, X-API-Key). */
export class DownloaderClient implements DownloaderLike {
  private base: string;

  constructor(baseUrl: string, private apiKey: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/v1${path}`, {
        method,
        headers: { 'X-API-Key': this.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new DownloaderError(`Downloader unreachable: ${err instanceof Error ? err.message : err}`, 'network');
    }
    if (res.ok) return res;
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 401) throw new DownloaderError('Downloader rejected the API key (401)', 'auth', 401);
    if (res.status === 503 && /api.*(disabled|not configured)|API_KEY/i.test(detail)) {
      throw new DownloaderError('Downloader API is disabled (set API_KEY on the downloader)', 'auth', 503);
    }
    if (res.status === 503 || res.status === 429) throw new DownloaderError(`Downloader busy (${res.status})`, 'busy', res.status);
    if (res.status === 404) throw new DownloaderError('Downloader job not found', 'notfound', 404);
    throw new DownloaderError(`Downloader HTTP ${res.status}: ${detail}`, 'http', res.status);
  }

  async createJob(trackId: string, format: string, bitrate: string): Promise<JobStatus> {
    const res = await this.call('POST', '/jobs', {
      url: `https://open.spotify.com/track/${trackId}`,
      format,
      bitrate,
      structured: false,
    });
    return (await res.json()) as JobStatus;
  }

  async getJob(jobId: string): Promise<JobStatus> {
    return (await (await this.call('GET', `/jobs/${encodeURIComponent(jobId)}`)).json()) as JobStatus;
  }

  async fetchFile(jobId: string, destPath: string): Promise<void> {
    const res = await this.call('GET', `/jobs/${encodeURIComponent(jobId)}/file`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_FILE_BYTES) throw new DownloaderError(`Refusing ${len}-byte download`, 'http');
    if (!res.body) throw new DownloaderError('Downloader returned an empty body', 'http');
    const part = `${destPath}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part, { mode: 0o664 }));
      await rename(part, destPath);
    } catch (err) {
      await rm(part, { force: true });
      throw new DownloaderError(`Download transfer failed: ${err instanceof Error ? err.message : err}`, 'network');
    }
  }

  async deleteJob(jobId: string): Promise<void> {
    await this.call('DELETE', `/jobs/${encodeURIComponent(jobId)}`);
  }
}
