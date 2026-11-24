# AutoSpotifySync: Plan

Sync a Spotify library into SQLite, cross-reference it with a Plex music library, and optionally auto-download and import whatever is missing via the custom spotify-downloader API.

## Decisions
| Area | Decision |
|---|---|
| Stack | TypeScript / Node, single Docker image for Unraid |
| Run mode | Daemon on a schedule (env-configurable interval) plus CLI in the same binary: `sync`, `status`, `missing`, `failed`, `retry`, `import` |
| Storage | SQLite in `/config` |
| Spotify scope | Own playlists, followed playlists, Liked Songs, saved albums |
| Matching | Plex API, normalized fuzzy match (artist and title), any release counts as "in Plex" (configurable: strict album match) |
| Format | `DOWNLOAD_FORMAT` / `DOWNLOAD_BITRATE` env, default mp3 / 320k |
| Verification | Cheap checks only, no ffprobe decode (see below) |
| Failures | 3 attempts with backoff, then `failed` (parked); retried only by `retry` or after a cooldown (default 7 days) |
| Safety | `DRY_RUN`, auto-download OFF by default, `MAX_DOWNLOADS_PER_RUN`, notifications (Discord/webhook/Gotify) |
| UI | Logging to stdout plus CLI now; web UI later on the same backend |

## Container config (all env vars, mapped as fields in the Unraid template)
**Connections**
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (required)
- `SPOTIFY_REFRESH_TOKEN` (optional, enables full-library mode, see Spotify auth)
- `SPOTIFY_PLAYLIST_URLS` (optional, comma-separated public playlist/album URLs, used in public-only mode)
- `PLEX_URL`, `PLEX_TOKEN`
- `PLEX_MUSIC_LIBRARY` (library name, user-supplied; if empty and Plex has exactly one music library, auto-detect it, otherwise fail with a list of the available names)
- `DOWNLOADER_URL`, `DOWNLOADER_API_KEY`

**Safety and behavior (every one overridable, with safe defaults)**
| Var | Default |
|---|---|
| `AUTO_DOWNLOAD` | `false` |
| `DRY_RUN` | `true` until you change it (forces no downloads/imports even if `AUTO_DOWNLOAD=true`) |
| `MAX_DOWNLOADS_PER_RUN` | `50` (`0` = unlimited) |
| `DOWNLOAD_CONCURRENCY` | `2` |
| `DOWNLOAD_RATE_PER_MIN` | `8` |
| `DOWNLOAD_FORMAT` / `DOWNLOAD_BITRATE` | `mp3` / `320k` |
| `RETRY_MAX_ATTEMPTS` | `3` |
| `RETRY_COOLDOWN_DAYS` | `7` |
| `MATCH_STRICT_ALBUM` | `false` |
| `MATCH_MIN_CONFIDENCE` | `0.85` |
| `DURATION_TOLERANCE_SEC` | `5` |
| `SYNC_INTERVAL` | `6h` |
| `NOTIFY_URL` | empty (disabled) |
| `LOG_LEVEL` | `info` |

**Volumes and user:** `/config` (SQLite, logs), `/music` (the Plex music share, same files Plex sees), `/staging` (optional, defaults under `/config`). Runs as `PUID=99` / `PGID=100`.

## Pipeline (per track)
`discovered -> matched | missing -> queued -> downloading -> downloaded -> imported -> verified (complete) | failed`

1. **Sync Spotify.** Pull playlists, Liked Songs and saved albums. Upsert tracks, playlists and membership (track ID plus ISRC where available). Track removals.
2. **Check Plex.** Snapshot the Plex artist/track index once per run and match locally (no per-track API calls). Score and normalize (strip feat./remaster/punctuation). High confidence means `matched` and complete. Low confidence goes to a review queue. No match means `missing`.
3. **Download (if enabled and not dry-run).** One job per track: `POST /api/v1/jobs` with the Spotify track URL, `format`, `bitrate`, `structured=false`. Persist `job_id`. Poll `GET /jobs/{id}`. On `done`, fetch `/jobs/{id}/file` into staging promptly (files purge about 30 min after a job finishes). Then `DELETE` the job.
4. **Import.** Tag from Spotify metadata (artist, album artist, album, track no., year, ISRC, cover art). Move to `/music/<Artist>/<Album>/<NN> - <Title>.<ext>` (sanitized).
5. **Verify.** File exists and is above a minimum size, tags present, and duration within about 5 s of Spotify's (header read, cheap). Then trigger a targeted Plex scan of that folder and re-run the match. Matched means `complete`. Anything else means `failed` and the file is quarantined.

## Downloader constraints (from its source, `app/main.py`)
- Auth: `X-API-Key` header. A 503 on every route means the downloader's `API_KEY` is unset.
- Input is Spotify track/album/playlist URLs only (no search, no bare IDs).
- 5 job slots (hardcoded), no queue. 503 when full means back off.
- `POST /jobs` is limited to 10 per 60 s per IP (source contradicts README). Default to 2 concurrent jobs and at most 8 submissions per minute, with backoff on 429/503.
- Job state is in memory. A 404 on a known `job_id` (downloader restarted) means resubmit.
- Tags and ISRC are not guaranteed from the downloader, so we write our own tags.
- Flat `{title}` template can collide within a multi-track job, hence one job per track.

## Milestones
1. Scaffold (TS, SQLite schema/migrations, config validation, logger, Dockerfile, CLI skeleton)
2. Spotify sync (auth, library pull, DB upsert) plus `status`
3. Plex index and matcher plus `missing` and review queue (dry-run end to end: this is a useful MVP by itself)
4. Downloader client, job runner, throttling, retry/park
5. Tagging, import, verify, targeted Plex scan
6. Scheduler, notifications, Unraid template (XML), README
7. Later: web UI (ARR-style), if wanted

## Repo and security practices (public GitHub)
- **Signed commits:** repo-local git config uses `hunter.clipper@gmail.com` with GPG key `E5FDD29AF0E04501`, `commit.gpgsign` and `tag.gpgsign` on. The global config points at the work key, so the local override is required. Add the public key to GitHub and enable "Vigilant mode".
- **No secrets in git:** `.env`, tokens, keys, the SQLite DB, logs and media are gitignored. Only `.env.example` (blank values) is committed. Add a pre-commit secret scan (gitleaks) and enable GitHub secret scanning plus push protection.
- **Runtime:** never log tokens, API keys or the Spotify secret (redact in the logger and in error output). Refresh token stays in env/`/config` only. Validate all env input at startup (zod).
- **Container:** non-root (99:100), read-only root FS where possible, no extra capabilities, pinned base image digest, multi-stage build, no secrets baked into image layers.
- **Supply chain:** commit the lockfile, `npm ci`, Dependabot, `npm audit` in CI, minimal dependencies.
- **Downloader trust:** treat downloaded files as untrusted. Sanitize all path components (no `..`, no absolute paths), only write under `/music`, validate extension/size before import. Use HTTPS to the downloader if exposed beyond the LAN.
- **GitHub:** protect `main` (require PR and signed commits), add `SECURITY.md`, MIT or similar `LICENSE`, and a README warning about legal use (personal-use downloads only; respect Spotify and YouTube terms).

## Open items
- **Spotify auth (decided: start with client ID + secret).**
  - *Public-only mode:* client ID + secret only (client-credentials flow). Per Spotify's Feb 2026 API changes it can only read **albums** listed in `SPOTIFY_PLAYLIST_URLS`; playlist contents need a user token. No Liked Songs, saved albums, or private playlists.
  - *Dev-mode limit:* `/playlists/{id}/items` only returns contents for playlists the user owns or collaborates on, so **followed playlists of other users cannot be synced** (skipped with a warning). Workaround to consider later: user copies them into their own playlist.
  - *Full-library mode:* adds a one-time user login (authorization-code flow) that yields `SPOTIFY_REFRESH_TOKEN`. The ID and secret are used to refresh it. A `spotify-sync auth` CLI command prints the login URL and accepts the pasted redirect URL, then prints the token to put in the env var. Needed for the "everything in my library" scope, with scopes `user-library-read`, `playlist-read-private`, `playlist-read-collaborative`.
  - Build order: public-only first (milestone 2a), full-library second (2b). Add `http://127.0.0.1:<port>/callback` as the redirect URI in the Spotify dashboard.
- **Plex:** whether track `guid`/ISRC is exposed. We'll fall back to artist+title if not. (Library name is now an env var.)
- **File ownership: decided.** Container runs as 99:100 (`nobody:users`) so Plex can read imported files.
- **Playlist-only vs album-aware downloads:** saved albums that are missing could download per track (default) or be grouped. Decide at milestone 4.
- **Plex playlists:** whether to mirror Spotify playlists into Plex (out of scope for v1).
