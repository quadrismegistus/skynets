# Deploying Skynets

The app is a static SPA. Any host serves it. What differs per deployment is the
**model config** — drop a `skynets.config.json` at the web root and the UI adapts.
No file (localhost / dev) → everything is configurable, as normal.

## `skynets.config.json`

| Field | Meaning |
|---|---|
| `provider` | `"ollama"` or `"anthropic"` — the fixed provider |
| `ollamaUrl` | Ollama endpoint, usually a same-origin proxy like `"/ollama"` |
| `model` | The one model users get (they can't change it) |
| `lock` | `true` → hide the provider/model/URL controls entirely |
| `hideOllama` | `true` → hide the Ollama option (a static https deploy that can't reach any local Ollama) |

Loaded once at startup via `fetch("/skynets.config.json")`. A host that returns
`index.html` for it (some SPA-fallback dev servers) is treated as "no config".

### Examples

**Hosted instance with a co-located, proxied Ollama** (e.g. lltk.net) — users just
press Digest, no knobs:

```json
{ "provider": "ollama", "ollamaUrl": "/ollama", "model": "qwen2.5:1.5b", "lock": true }
```

**Cloud-only static deploy** (e.g. GitHub Pages) — https can't reach any local
Ollama, so offer Anthropic (BYO key) / demo only:

```json
{ "provider": "anthropic", "hideOllama": true }
```

## Hosting on a box with Ollama (the lltk.net pattern)

Co-locate Ollama with the site and proxy it same-origin, so a deployed https page
can use the local model (no CORS / `OLLAMA_ORIGINS` dance, no client setup):

1. **Ollama** as a cgroup-capped systemd service, bound to `127.0.0.1:11434`, with
   `OLLAMA_NUM_PARALLEL=1` (serialize on CPU). Pull one small model.
2. **nginx**: serve the built SPA; proxy `/ollama/` → `http://127.0.0.1:11434/`,
   with `limit_req` to rate-limit and an auth gate so it isn't an open resource.
3. Drop the `lock` config above (with `"ollamaUrl": "/ollama"`).

Result: a shareable URL where the local-model digest works with zero client setup —
what Tauri would otherwise be for, solved by co-location.
