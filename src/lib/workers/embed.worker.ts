/// <reference lib="webworker" />
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

/**
 * On-device text embedding, off the main thread.
 *
 * A worker is not optional here: MiniLM inference on WASM blocks for hundreds of
 * milliseconds, and the graph is running a d3-force simulation at 60fps. On the
 * main thread every embed would visibly hitch the layout.
 *
 * Everything is self-hosted. `allowRemoteModels = false` is the load-bearing
 * line — without it transformers.js silently falls back to the HuggingFace CDN,
 * which would put a third party back in the path we just removed one from.
 */

// Vite compiles workers too, so BASE_URL resolves here — '/' on mothtrap.blue,
// '/mothtrap/' on GitHub Pages. Hard-coding '/' would 404 on Pages.
const BASE = import.meta.env.BASE_URL ?? '/'

env.allowRemoteModels = false // never phone home; a missing file must fail loudly
env.allowLocalModels = true
env.localModelPath = `${BASE}models/`
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = `${BASE}models/ort/`
  // One thread: we embed a handful of 2-4 word labels, so spinning up a thread
  // pool costs more than it saves — and cross-origin isolation (which threaded
  // wasm needs) isn't something we want to require of the page.
  env.backends.onnx.wasm.numThreads = 1
}

let extractor: Promise<FeatureExtractionPipeline> | undefined

function load(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline('feature-extraction', 'all-MiniLM-L6-v2', {
    dtype: 'q8', // the int8 weights we ship; fp32 would be 86MB
    device: 'wasm',
  })
  return extractor
}

export interface EmbedRequest {
  id: number
  texts: string[]
}
export interface EmbedResponse {
  id: number
  vectors?: number[][]
  error?: string
}

self.onmessage = async (e: MessageEvent<EmbedRequest>) => {
  const { id, texts } = e.data
  try {
    const fe = await load()
    // Mean-pool + L2 normalize: the sentence-transformers convention this model
    // was trained under, and what Ollama's /api/embed returns — so the vectors
    // land in the same space as any already cached.
    const out = await fe(texts, { pooling: 'mean', normalize: true })
    const dims = out.dims as number[]
    const flat = Array.from(out.data as Float32Array | number[]) as number[]
    const width = dims[dims.length - 1]
    const vectors: number[][] = []
    for (let i = 0; i < texts.length; i++) vectors.push(flat.slice(i * width, (i + 1) * width))
    const res: EmbedResponse = { id, vectors }
    self.postMessage(res)
  } catch (err) {
    const res: EmbedResponse = {
      id,
      error: err instanceof Error ? err.message : 'embedding failed',
    }
    self.postMessage(res)
  }
}
