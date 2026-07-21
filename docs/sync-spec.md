# Cross-device sync — design spec

**Status:** Phase 0 in progress. **Invariant:** only ciphertext ever leaves the device; no
Mothtrap backend; the user's own PDS is the transport.

Mothtrap keeps all personal signal on-device (per-DID IndexedDB / idb-keyval). This spec adds
optional cross-device sync **without breaking the "never leaves the device" promise** — the only
thing that leaves is AES-GCM ciphertext the user holds the key to.

## 1. Scope

**Sync:** reactions (private up/down votes), the dismissed/read set, and (later) a few settings.
**Never sync:** the archive corpus, embeddings, digest labels, reload-paint snapshot — they are a
cache and rebuild from the feed. Keeping the payload to the KB of *judgments* is what lets the whole
state fit in one encrypted record.

## 2. Data model — LWW CRDTs

Every synced field becomes a **last-write-wins map keyed by post URI** (or setting name), each entry
carrying a wall-clock `t` (ms). Merge is per-key: highest `t` wins. Conflict-free for our access
pattern; no coordination needed.

```
SyncDoc v1 {
  account:   <did>                                        // guard: only merge into the same account
  reactions: { <uri>: { r: 'up'|'down'|null, did, t } }   // r:null = tombstone (cleared)
  dismissed: { <uri>: { d: true|false, t } }              // d:false = tombstone (un-dismissed)
  settings:  { <key>: { val, t } }
}
```

Full LWW needs two store changes (deferred to live sync, see Phase plan):
- **Reactions** must write a **tombstone on toggle-off** instead of deleting the row, or a clear on
  one device is resurrected by an older doc on another. (`reactions.svelte.ts`.)
- **Dismissed** needs a **per-URI timestamp** — `read.restore()` (undo) means it is not grow-only, so
  it needs LWW too. Keep the `SvelteSet` hot path, back it with a timestamped map. (`read.svelte.ts`.)

**Pruning:** dismissed grows unbounded; drop entries older than **~90 days** from the *synced* doc — a
post dismissed months ago will not reappear in the timeline anyway. Reactions are few and never pruned.

## 3. Crypto

- **AES-256-GCM** (WebCrypto), random 96-bit IV per write. The GCM auth tag *is* the wrong-passphrase
  detector (decryption fails on a wrong key) — no separate marker needed.
- Key from a **sync passphrase** via **PBKDF2-HMAC-SHA256, ≥600k iterations, 16-byte random salt**
  (salt + IV stored beside the ciphertext; not secret). Argon2id (WASM) is Phase-3 hardening.
- Passphrase never transmitted. Derived key in memory; persisted in **Keychain on native (Tauri)**,
  re-entered or IDB-with-caveat on web.
- gzip the JSON before encrypting (dismissed URIs compress well) — live-sync phase; Phase 0 skips it.

## 4. atproto storage (live sync)

- One record: collection `blue.mothtrap.sync.state`, rkey `self` (we own `mothtrap.blue` → NSID
  `blue.mothtrap`). Ciphertext in a **blob**; record holds `{version, updatedAt, kdf, salt, iv, cipher,
  blobRef, deviceId}`.
- Auth: `agent.com.atproto.repo.putRecord/getRecord` against the user's **own** repo — the existing
  OAuth/app-password session authorizes it. No new auth.
- **Publicness is fine** — the record is on the firehose but it is ciphertext. This is the key move: we
  do not need atproto's (immature) private storage; encryption makes a *public* record safe. Migrate to
  real private records later if they ship, for less metadata.
- Concurrency: `putRecord` with **`swapRecord` (CAS on the record CID)** → on conflict, re-pull-merge-
  push. Unreferenced blobs GC when the record is overwritten.

## 5. Sync loop (live sync)

```
on login / reconnect / debounced ~15s after a local write / manual "sync now":
  pull:  getRecord(self) → blob → decrypt → remoteDoc   (skip if remote hash unchanged)
  merge: LWW(localStore, remoteDoc) → mergedDoc
  apply: write mergedDoc back into reactions/read/settings (reactively)
  push:  if mergedDoc ≠ remoteDoc → gzip+encrypt → putBlob → putRecord(swapRecord=CID)
         on CAS conflict → retry from pull
```
Echo guard: track `lastPushedHash` so applying a merge does not re-trigger a push. Offline writes
accumulate and reconcile via LWW on reconnect. Merge is idempotent → a crash mid-apply re-converges.

## 6. Threat model

An observer (firehose reader, PDS operator, Bluesky) sees: **ciphertext, that the record exists, its
size (≈ number of judgments), and update cadence.** They do **not** see which posts, reactions, or
authors. Residual leak is metadata; the passphrase and plaintext never leave. Mothtrap operators see
nothing (no backend). Non-goal: hiding *that* you use Mothtrap (the record `$type` reveals it).

## 7. Failure modes

Wrong passphrase → GCM auth failure, refuse merge, re-prompt. Lost passphrase → local data survives;
offer "reset sync" (overwrite remote from local); no key recovery (the E2E cost). Clock skew →
wall-clock LWW hazard, hardened later with a hybrid logical clock. Account switch → drop key, per-DID
doc throughout; refuse to merge a doc whose `account` ≠ current session DID.

## 8. Phased build

- **Phase 0 (validates demand) — THIS PR.** Encrypted **export / import** to a file, using this exact
  doc format + crypto. No atproto, no live sync. De-risks the doc/merge/crypto before any sync.
  - **Decisions taken:** passphrase key (no QR yet); **no prune** (the export doubles as a backup);
    **no store refactor** — build the doc from current store data, merge on import as reactions-LWW-by-
    existing-`t` + dismissed-**union** (safe: dismissals are add-mostly; a rare restore-then-import may
    re-dismiss). Tombstones/timestamps arrive with live sync.
  - Phase-0 doc: `{ v, account, reactions: Reaction[], dismissed: string[] }`.
- **Phase 1:** one-way **pull-on-start** (a new device pulls + merges). Proves decrypt/merge/apply.
- **Phase 2:** full **bidirectional loop** (pull-merge-push, CAS, debounce) + the store refactor
  (reaction tombstones, dismissed timestamps) + settings.
- **Phase 3:** hardening — HLC clocks, Argon2id, QR key-transfer, dismissed pruning, native Keychain.

## 9. New code surface

- `api/sync.ts` — pure: `SyncDoc`/envelope types, `encryptDoc`/`decryptDoc`, `mergeReactions` (LWW),
  `mergeDismissed` (union), base64 helpers. Unit-tested.
- `state/sync.svelte.ts` — `buildDoc()` (reads stores), `applyDoc(doc)` (writes stores),
  `exportToFile(passphrase)`, `importFromFile(file, passphrase)`.
- `reactions.svelte.ts` — additive `importRows(rows)` (LWW-merge, no refactor).
- `Settings.svelte` — a "Sync across devices (beta)" section: passphrase + Export / Import.
