# AutoSpotifySync

Sync your Spotify library into a local SQLite database, cross-reference it with your Plex
music library, and report what is missing. Later milestones add automatic download (via a
companion [spotify-downloader](https://github.com/Hunter-Clipper/spotify-downloader) API),
import, and verification. See [PLAN.md](PLAN.md) for the design and roadmap.

**Status:** early development. Today: Spotify sync, Plex matching, and `missing`/`review`
reports. Nothing is downloaded or modified in your music library yet.

> **Legal:** intended for personal use with music you are entitled to have. You are
> responsible for complying with the terms of the services you use and the laws that apply
> to you.

## Spotify access modes
| Mode | Needs | Sees |
|---|---|---|
| Public-only | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_PLAYLIST_URLS` | The listed public playlists and albums |
| Full library | Above, plus `SPOTIFY_REFRESH_TOKEN` | Your playlists (own and followed), Liked Songs, saved albums |

Generating the refresh token with a built-in command is planned. Until then, use any
standard Spotify authorization-code flow with scopes `user-library-read`,
`playlist-read-private` and `playlist-read-collaborative`.

## Run
```bash
cp .env.example .env   # fill in values; never commit .env
docker build -t autospotifysync .
docker run --rm --env-file .env -v /path/to/appdata/autospotifysync:/config autospotifysync sync
docker run --rm --env-file .env -v /path/to/appdata/autospotifysync:/config autospotifysync missing
```
The container runs as `99:100` (Unraid `nobody:users`); `/config` must be writable by it.

Commands: `sync`, `status`, `missing [-n N] [--json]`, `review [-n N] [--json]`.

## Develop
```bash
npm ci
npm test
npm run typecheck
npm run dev -- status
```
Requires Node 22.13+ (uses built-in `node:sqlite`).
