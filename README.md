# Mothtrap

A network-map Bluesky client with a local-LLM digest — set the light, see what flew
in. The spirit of [Mastotron](../mastotron) rebuilt for Bluesky in Svelte.
Live at **https://mothtrap.blue**. See [PLAN.md](./PLAN.md) for the design and
roadmap, and [docs/DEPLOY.md](./docs/DEPLOY.md) for deployments.

> Formerly **Skynets**; renamed 2026-07. A moth trap is the moth-er's instrument:
> a lamp left on overnight, and in the morning you calmly catalogue what came —
> which is what the digest does to your feed. (Persistent-storage keys still carry
> the `skynets` prefix so existing users' local data survives the rename.)

## Develop

```bash
npm install
npm run dev      # http://127.0.0.1:1997
npm run check    # type-check
npm test         # unit tests (vitest)
npm run build    # production build to dist/
```

Append `?demo=1` to the dev URL to render the graph with local fixture posts and no
login — handy for UI work and Playwright screenshots.

Open the app at **http://127.0.0.1:1997** (not `localhost`) — atproto's OAuth
loopback dev mode requires the `127.0.0.1` origin.

## Signing in

Two paths, both keeping your credentials off any Mothtrap server (there is no server):

- **Sign in with Bluesky (OAuth)** — the preferred path. You authenticate on
  Bluesky's own page; Mothtrap never sees your password. Tokens and DPoP keys live in
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

## Deploy

Mothtrap is a static SPA — `vite build` emits `dist/`, no server or SvelteKit adapter
needed. Two live instances (per-instance behavior is set by a `mothtrap.config.json`
at the web root — see [docs/DEPLOY.md](./docs/DEPLOY.md)):

- **https://mothtrap.blue** (primary) — the lltk.net box, with a co-located,
  cgroup-capped Ollama proxied at `/ollama`; the config locks the model so visitors
  just press Digest. Deployed by `scripts/deploy.sh` (build + rsync; the server-side
  config file is never overwritten).
- **https://ryanheuser.com/mothtrap/** (secondary, GitHub Pages) — built and
  published by `.github/workflows/ci.yml` on every push to `main`. A static cloud
  deploy can't reach any local Ollama, so its config hides that option. The workflow
  sets `BASE_PATH=/mothtrap/` and generates OAuth client metadata via
  `npm run gen:metadata` (driven by `APP_URL`; the metadata URL *is* the OAuth
  `client_id`, passed to the build as `VITE_OAUTH_CLIENT_ID`).

**One-time setup for Pages:** in the repo's Settings → Pages, set **Source: GitHub
Actions**, then push to `main`. To move to a subdomain later, change the three `env`
values in the workflow to that root with `BASE_PATH=/` — no code changes.

## Status

- **Milestone 1 (done):** Vite + Svelte 5 scaffold; OAuth *and* app-password login,
  both with session resume; a home-timeline list view.
- **Milestone 2 (done):** the semantic graph — timeline posts as avatar nodes laid
  out by engagement (x) and recency (y), reply edges, hover cards, Graph/List toggle.
- **Milestone 3+ (done):** triage (dismiss/persist), thread grouping, local archive
  with rolling digest, per-post LLM labeling with embedding merge, coverage view,
  per-deployment config. See PLAN.md's status banner.
