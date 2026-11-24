# Security Policy

## Reporting a vulnerability
Please report security issues privately through GitHub's
["Report a vulnerability"](../../security/advisories/new) feature on this repository
rather than opening a public issue.

## Handling secrets
This tool uses a Spotify client secret and refresh token, a Plex token and a downloader
API key. Supply them only through environment variables (or your Unraid container
template). Never commit a `.env` file, and rotate any credential that has been exposed.
Secrets are scrubbed from log output, but review logs before sharing them.
