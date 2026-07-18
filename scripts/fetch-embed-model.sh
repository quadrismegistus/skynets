#!/usr/bin/env bash
# Fetch the on-device embedding model into public/models/ so the browser can
# embed topic labels locally instead of posting them to a server.
#
# Self-hosted on purpose: transformers.js would otherwise pull these from the
# HuggingFace CDN at RUNTIME, which is a third party seeing our users' IPs for
# no good reason. Fetching here happens on the BUILD machine — no user ever
# touches HuggingFace. That makes this a supply-chain question, not a privacy
# one, and it is answered by pinning and verifying rather than by trusting.
#
#   PINNED to an immutable revision, not `main`, so a change upstream can never
#   silently alter what we ship. Every file is SHA-256 verified against the
#   bytes actually tested (384-dim vectors; 0.678 vs 0.121 on the known-good
#   pair). A mismatch is a hard failure, not a warning.
#
#   FAILURE IS FATAL. A missing model doesn't break the app — it degrades to
#   token-overlap grouping — and that is exactly why this must not be quiet: a
#   silently-degraded build is indistinguishable from a working one until
#   somebody probes vector dimensionality, which is how this very feature
#   fooled us once already. Set ALLOW_MISSING_EMBED_MODEL=1 to opt out (offline
#   dev) and accept a build whose digest groups by token overlap.
#
# NOT committed (public/models/ is gitignored): 23MB of weights has no business
# in git history, where it would be immortal. Cache it in CI on this file's hash
# instead. Run automatically by `npm run build` via prebuild.
#
# all-MiniLM-L6-v2 is the same model the Ollama path used, so vectors stay in
# the same 384-dim space — cached vectors survive and the road-tested 0.68 merge
# threshold still means what it meant.
set -uo pipefail
cd "$(dirname "$0")/.."

REPO=Xenova/all-MiniLM-L6-v2
REV=751bff37182d3f1213fa05d7196b954e230abad9 # immutable; bump deliberately
BASE="https://huggingface.co/${REPO}/resolve/${REV}"
DEST=public/models/all-MiniLM-L6-v2

# path:sha256 — regenerate with `shasum -a 256` after a deliberate REV bump.
FILES=(
  "config.json:7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7"
  "tokenizer.json:da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"
  "tokenizer_config.json:9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3"
  "special_tokens_map.json:b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3"
  "onnx/model_quantized.onnx:afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"
)

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

fail() {
  echo "ERROR: $1" >&2
  if [ "${ALLOW_MISSING_EMBED_MODEL:-0}" = "1" ]; then
    echo "ALLOW_MISSING_EMBED_MODEL=1 — continuing; the digest will group by token overlap." >&2
    exit 0
  fi
  echo "Set ALLOW_MISSING_EMBED_MODEL=1 to build anyway (digest degrades to token grouping)." >&2
  exit 1
}

mkdir -p "$DEST/onnx"

for entry in "${FILES[@]}"; do
  f="${entry%%:*}"
  want="${entry##*:}"
  out="$DEST/$f"

  # Re-verify what's already on disk. A truncated or tampered cache is exactly
  # what a checksum is for; trusting mere existence would defeat it.
  if [ -s "$out" ]; then
    if [ "$(sha256_of "$out")" = "$want" ]; then
      echo "  ok    $f"
      continue
    fi
    echo "  stale $f (checksum mismatch) — refetching"
    rm -f "$out"
  fi

  echo "  fetch $f"
  if ! curl -fsSL --max-time 300 "$BASE/$f" -o "$out.part"; then
    rm -f "$out.part"
    fail "could not download $f from ${REPO}@${REV:0:7}"
  fi
  got="$(sha256_of "$out.part")"
  if [ "$got" != "$want" ]; then
    rm -f "$out.part"
    fail "checksum mismatch for $f
    expected $want
    got      $got"
  fi
  mv "$out.part" "$out"
done

# The ONNX runtime's wasm ships inside node_modules, already pinned by
# package-lock, so it needs no checksum here — but transformers.js would fetch
# it from a CDN if we didn't serve it ourselves.
#
# Copy ALL the CPU variants: ORT picks one at RUNTIME per browser, and a missing
# one raises "no available backend found", which the caller swallows into the
# token fallback — a silent degradation that looks exactly like success. jsep is
# skipped: it's the 25MB WebGPU build, and we pin device:'wasm'.
ORT=node_modules/onnxruntime-web/dist
[ -d "$ORT" ] || fail "onnxruntime-web not installed — run npm install first"
mkdir -p public/models/ort
for f in ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.mjs \
         ort-wasm-simd-threaded.asyncify.wasm ort-wasm-simd-threaded.asyncify.mjs \
         ort-wasm-simd-threaded.jspi.wasm ort-wasm-simd-threaded.jspi.mjs; do
  [ -f "$ORT/$f" ] || fail "$f missing from onnxruntime-web — its layout changed; update this list"
  cp -f "$ORT/$f" public/models/ort/
done

echo "embedding model ready: ${REPO}@${REV:0:7} ($(du -sh "$DEST" | cut -f1) weights + $(du -sh public/models/ort | cut -f1) runtime)"
