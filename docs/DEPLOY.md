# Deploying Mothtrap

The app is a static SPA. Any host serves it. What differs per deployment is the
**model config** — drop a `mothtrap.config.json` at the web root and the UI adapts.
(The pre-rename `skynets.config.json` is still read as a fallback.) No file
(localhost / dev) → everything is configurable, as normal.

The primary deploy is **https://mothtrap.blue** (live since 2026-07-16): the
lltk.net Hetzner box, set up exactly as described below; redeploy with
`scripts/deploy.sh`. The secondary is GitHub Pages at ryanheuser.com/mothtrap/
(cloud-only config, written by the CI workflow).

## `mothtrap.config.json`

| Field | Meaning |
|---|---|
| `provider` | `"ollama"` or `"anthropic"` — the fixed provider |
| `ollamaUrl` | Ollama endpoint, usually a same-origin proxy like `"/ollama"` |
| `model` | The one model users get (they can't change it) |
| `lock` | `true` → hide the provider/model/URL controls entirely |
| `hideOllama` | `true` → hide the Ollama option (a static https deploy that can't reach any local Ollama) |

Loaded once at startup via `fetch("/mothtrap.config.json")` (then the legacy filename). A host that returns
`index.html` for it (some SPA-fallback dev servers) is treated as "no config".

### Examples

**Hosted instance with a co-located, proxied Ollama** (mothtrap.blue) — users just
press Digest, no knobs:

```json
{ "provider": "ollama", "ollamaUrl": "/ollama", "model": "qwen2.5:1.5b", "lock": true }
```

**Cloud-only static deploy** (e.g. GitHub Pages) — https can't reach any local
Ollama, so offer Anthropic (BYO key) / demo only:

```json
{ "provider": "anthropic", "hideOllama": true }
```

## Hosting on a box with Ollama (the mothtrap.blue setup)

Co-locate Ollama with the site and proxy it same-origin, so a deployed https page
can use the local model (no CORS / `OLLAMA_ORIGINS` dance, no client setup):

1. **Ollama** as a cgroup-capped systemd service, bound to `127.0.0.1:11434`,
   `OLLAMA_NUM_PARALLEL=1` (serialize on CPU). Pull one small model. The cap keeps
   us a good neighbour to the other services on the box — a low CPU weight means
   any interactive/latency-sensitive process always preempts inference:

   ```ini
   # /etc/systemd/system/ollama.service.d/override.conf
   [Service]
   CPUWeight=10        # ~nice; other services always win the CPU
   CPUQuota=300%       # hard ceiling: ≤3 of 12 cores, even when the box is idle
   Nice=19
   MemoryMax=4G
   Environment=OLLAMA_HOST=127.0.0.1:11434
   Environment=OLLAMA_NUM_PARALLEL=1
   ```
2. **nginx**: add an isolated `server` block (a new `sites-available/mothtrap`
   vhost — independent of the other sites); serve the built SPA; proxy `/ollama/`
   → `http://127.0.0.1:11434/`, with `limit_req` to rate-limit and an auth gate
   so it isn't an open resource.
3. Drop the `lock` config above (with `"ollamaUrl": "/ollama"`).

**Neighbour budget** (agreed with all three other services on the box — a chess
bot, the prosodic parser, and the lltk corpus viewer / ClickHouse): stay ≤3 cores
at low priority, ≤4 GB RAM, serialized. `CPUQuota=300%` honours the tightest ask
(prosodic's single-threaded parser) and comfortably clears the others — the chess
bot wanted 4 cores free (gets 9), and lltk only asked that we sit below ClickHouse
in scheduling priority (`CPUWeight=10`/`Nice=19` does exactly that) and under
~4–6 GB (`MemoryMax=4G` clears it). All three confirmed port 11434 free and their
nginx vhosts isolated. Give a heads-up before any *sustained/uncapped* run (a huge
backlog re-label, or re-enabling cluster mode) — routine label bursts need none.

Result: a shareable URL where the local-model digest works with zero client setup —
what Tauri would otherwise be for, solved by co-location.
