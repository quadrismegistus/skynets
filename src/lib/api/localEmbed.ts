import type { EmbedRequest, EmbedResponse } from '../workers/embed.worker'

/**
 * Client side of the on-device embedder. Owns one lazily-spawned worker.
 *
 * LAZY is the point. The model and ONNX runtime are ~19MB gzipped, which would
 * be an absurd thing to make every visitor download before they've seen the
 * graph. Nothing is fetched until something actually asks for a vector — so the
 * cost falls only on people who use the digest, once, and is then cached by the
 * browser like any other static asset.
 */

let worker: Worker | undefined
let seq = 0
const pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>()

/** True once we've decided the local path can't work, so we stop retrying it. */
let unavailable = false

function spawn(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('../workers/embed.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<EmbedResponse>) => {
    const { id, vectors, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (error) p.reject(new Error(error))
    else p.resolve(vectors ?? [])
  }
  w.onerror = (e) => {
    // The worker itself failed to boot (no wasm, blocked module worker…). Fail
    // every waiter and don't try again this session — the caller has a local
    // fallback and shouldn't pay a load timeout per batch.
    unavailable = true
    for (const [, p] of pending) p.reject(new Error(e.message || 'embed worker failed'))
    pending.clear()
    worker = undefined
  }
  worker = w
  return w
}

export function localEmbedAvailable(): boolean {
  return !unavailable && typeof Worker !== 'undefined'
}

/**
 * Embed texts on this device. Rejects if the model can't be loaded — callers
 * are expected to fall back to something that is ALSO local (token overlap),
 * never to sending the text somewhere.
 */
export function localEmbed(texts: string[], timeoutMs = 120_000): Promise<number[][]> {
  if (texts.length === 0) return Promise.resolve([])
  if (!localEmbedAvailable()) return Promise.reject(new Error('local embedding unavailable'))
  const w = spawn()
  const id = ++seq
  return new Promise<number[][]>((resolve, reject) => {
    // First call pays for a ~19MB download plus warm-up, so the timeout is
    // generous; later calls return in milliseconds.
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('local embedding timed out'))
    }, timeoutMs)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    const req: EmbedRequest = { id, texts }
    w.postMessage(req)
  })
}

/** Drop the worker (and its ~100MB of loaded weights) — used on logout. */
export function disposeLocalEmbed() {
  worker?.terminate()
  worker = undefined
  pending.clear()
}
