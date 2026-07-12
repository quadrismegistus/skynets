# Skynets

A network-map Bluesky client — the spirit of [Mastotron](../mastotron) rebuilt for
Bluesky in Svelte. See [PLAN.md](./PLAN.md) for the design and roadmap.

## Develop

```bash
npm install
npm run dev      # http://127.0.0.1:1997
npm run check    # type-check
npm run build    # production build to dist/
```

Open the app at **http://127.0.0.1:1997** (not `localhost`) — atproto's OAuth
loopback dev mode requires the `127.0.0.1` origin.

## Signing in

Two paths, both keeping your credentials off any Skynets server (there is no server):

- **Sign in with Bluesky (OAuth)** — the preferred path. You authenticate on
  Bluesky's own page; Skynets never sees your password. Tokens and DPoP keys live in
  IndexedDB, managed by `@atproto/oauth-client-browser`.
  - In dev this uses **loopback mode** (no hosting needed), which has two quirks:
    the app must run on `127.0.0.1`, and refresh tokens expire after ~1 day, so you
    re-authenticate daily.
  - For production, host a `client-metadata.json` at a stable HTTPS URL and set
    `VITE_OAUTH_CLIENT_ID` to that URL (which *is* the OAuth `client_id`). No other
    code change needed.
- **App password** — fallback/convenience. Uses a Bluesky
  [app password](https://bsky.app/settings/app-passwords) (not your main password),
  stored in this browser's localStorage. Works on any origin with no setup.

## Deploy (GitHub Pages)

Skynets is a static SPA — `vite build` emits `dist/`, no server or SvelteKit adapter
needed. The included workflow (`.github/workflows/deploy.yml`) builds and publishes to
GitHub Pages on every push to `main`, deploying to **https://ryanheuser.com/skynets/**.

Two things the workflow handles that production OAuth needs:

- **Base path** — project pages serve under `/skynets/`, so the build sets
  `BASE_PATH=/skynets/`.
- **OAuth client metadata** — `npm run gen:metadata` (driven by `APP_URL`) writes
  `public/client-metadata.json`, served at
  `https://ryanheuser.com/skynets/client-metadata.json`. That URL is the OAuth
  `client_id`, passed to the build as `VITE_OAUTH_CLIENT_ID`, which flips OAuth out of
  loopback dev mode into the hosted-metadata production mode.

**One-time setup:** in the repo's Settings → Pages, set **Source: GitHub Actions**, then
push to `main`. To move to a subdomain later (e.g. `skynets.ryanheuser.com`), change the
three `env` values in the workflow to that root with `BASE_PATH=/` — no code changes.

## Status

- **Milestone 1 (done):** Vite + Svelte 5 scaffold; OAuth *and* app-password login,
  both with session resume; a home-timeline list view.
- **Milestone 2 (done):** the semantic graph — timeline posts as avatar nodes laid
  out by engagement (x) and recency (y), reply edges, hover cards, Graph/List toggle.

Next: the triage loop (dismiss + persist, queue/turnover, keyboard actions) —
milestone 3.
