#!/usr/bin/env bash
# Fetch the local embedding model into public/models/ so the browser can embed
# topic labels on-device instead of posting them to a server.
#
# Self-hosted on purpose: transformers.js would otherwise pull these from the
# HuggingFace CDN at runtime, which is a third party seeing our users' IPs for
# no good reason. These are static assets — serve them ourselves.
#
# NOT committed (public/models/ is gitignored): ~22MB of weights has no business
# in the repo. Run by `npm run build` via prebuild, and in CI before a deploy.
#
# Deliberately NON-FATAL. A failed download must not break the build: the app
# degrades to token-overlap grouping when the model is missing, which is worse
# but still works, and still local.
#
# all-MiniLM-L6-v2 is the same model the Ollama path used, so vectors stay in
# the same 384-dim space — cached vectors survive and the road-tested 0.68 merge
# threshold still means what it meant.
set -uo pipefail
cd "$(dirname "$0")/.."

REPO=Xenova/all-MiniLM-L6-v2
BASE="https://huggingface.co/${REPO}/resolve/main"
DEST=public/models/all-MiniLM-L6-v2

FILES=(
  "config.json"
  "tokenizer.json"
  "tokenizer_config.json"
  "special_tokens_map.json"
  "onnx/model_quantized.onnx"
)

mkdir -p "$DEST/onnx"

ok=1
for f in "${FILES[@]}"; do
  out="$DEST/$f"
  if [ -s "$out" ]; then
    echo "  have  $f"
    continue
  fi
  echo "  fetch $f"
  if ! curl -fsSL --max-time 300 "$BASE/$f" -o "$out.part"; then
    echo "  WARN: could not fetch $f — the app will fall back to token grouping" >&2
    rm -f "$out.part"
    ok=0
    continue
  fi
  mv "$out.part" "$out"
done

# The ONNX runtime's wasm ships inside node_modules; transformers.js would
# otherwise pull it from a CDN. Copy the plain SIMD build (12MB) — NOT the jsep
# one (25MB), which exists for WebGPU we don't need to embed four-word labels.
ORT=node_modules/onnxruntime-web/dist
if [ -d "$ORT" ]; then
  mkdir -p public/models/ort
  # ORT picks a wasm variant at RUNTIME (asyncify / jspi / plain) depending on
  # the browser, and a missing one is fatal: "no available backend found", which
  # degrades silently to token grouping. Ship all the CPU variants and let it
  # choose — each client downloads exactly one. jsep is skipped: it is the 25MB
  # WebGPU build, and we pin device:'wasm' for a job this small.
  for f in ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.mjs \
           ort-wasm-simd-threaded.asyncify.wasm ort-wasm-simd-threaded.asyncify.mjs \
           ort-wasm-simd-threaded.jspi.wasm ort-wasm-simd-threaded.jspi.mjs; do
    [ -f "$ORT/$f" ] && cp -f "$ORT/$f" public/models/ort/ && echo "  copy  $f"
  done
else
  echo "  WARN: onnxruntime-web not installed; run npm install first" >&2
  ok=0
fi

if [ "$ok" = 1 ]; then
  echo "embedding model ready in $DEST ($(du -sh "$DEST" | cut -f1))"
else
  echo "embedding model INCOMPLETE — build continues; runtime will degrade gracefully" >&2
fi
exit 0
