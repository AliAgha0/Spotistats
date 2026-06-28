
# Spotistats

A full-stack TypeScript Spotify analytics dashboard.

## Stack

- React + TypeScript frontend powered by Vite.
- Express + TypeScript backend.
- Spotify Authorization Code with PKCE.
- Server-managed Spotify session tokens in an HTTP-only cookie-backed session.
- IndexedDB for local Spotify history imports.

## What it shows

- Top artists and tracks from Spotify's supported API ranges: 4 weeks, 6 months, and long term.
- Recently played track sample from the Spotify Web API.
- Exact time-listened stats by artist and song after importing Spotify account data JSON.
- Time filters for imported history: all time, last year, last 3 months, last month, and last week.

## Spotify refresh-token change

Spotify says that starting July 20, 2026, refresh tokens issued for user-authorized apps expire after six months. This app handles that by:

- detecting `invalid_grant` during refresh-token exchange;
- immediately discarding the stored token;
- returning a `reauthorization_required` API response to the frontend;
- asking the user to sign in again.

The important backend logic lives in `src/server/index.ts`.

## Run locally

Install dependencies:

```powershell
npm.cmd install
```

Start the full-stack dev app:

```powershell
npm.cmd run dev
```

Open:

```text
http://127.0.0.1:5173/
```

## Spotify setup

1. Create an app in the Spotify Developer Dashboard.
2. Add this redirect URI to the app:

```text
http://127.0.0.1:8787/api/auth/callback
```

3. Paste the app's Client ID into Spotistats.
4. Log in with Spotify.

The app uses these scopes:

```text
user-top-read user-read-recently-played user-read-private user-read-email
```

## Production build

```powershell
npm.cmd run build
npm.cmd start
```

For deployment, set these environment variables if your host/ports differ:

```text
PORT=8787
HOST=127.0.0.1
CLIENT_URL=https://your-app.example.com
SPOTIFY_REDIRECT_URI=https://your-app.example.com/api/auth/callback
```

## Exact listening time

Spotify's live Web API does not expose exact lifetime minutes listened. For those stats, request your Spotify account data and import JSON files named like `StreamingHistory_music_*.json` or Extended Streaming History files. Spotistats keeps imported listening records in this browser's IndexedDB.

# Spotistats
>>>>>>> 29cd4e68681c9d9189a7cf42dff83563aebc67c0
