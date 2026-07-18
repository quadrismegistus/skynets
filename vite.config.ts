import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const MIME: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

/**
 * Serve `/models/*` as raw bytes in dev.
 *
 * The ONNX runtime resolves its wasm loader with a dynamic `import()`, and Vite
 * appends `?import` to those — which routes the request into the module
 * transform pipeline, where a file living in `public/` is refused outright
 * ("should not be imported from source code"). A plain fetch of the same URL
 * succeeds, so this only bites the dynamic-import path.
 *
 * Production never sees it: the built app serves `public/` as static files. That
 * is why the on-device embedder worked in every build and in `vite preview`, and
 * broke only under `npm run dev` — which is exactly the gap in how it was
 * tested. Intercepting before Vite's own middleware (the non-returning
 * configureServer form) makes dev behave the way production already does.
 */
const serveModelsRaw: Plugin = {
  name: 'mothtrap-serve-models-raw',
  configureServer(server) {
    const modelsRoot = path.resolve(server.config.root, 'public', 'models')
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0]
      if (!url.startsWith('/models/')) return next()
      const file = path.resolve(server.config.root, 'public', url.slice(1))
      // Refuse anything that escapes the models directory.
      if (!file.startsWith(modelsRoot + path.sep)) return next()
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next()
      res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream')
      fs.createReadStream(file).pipe(res)
    })
  },
}

export default defineConfig({
  plugins: [svelte(), serveModelsRaw],
  // GitHub Pages project pages serve under /<repo>/. Set BASE_PATH at build
  // time (the deploy workflow does); dev stays at root.
  base: process.env.BASE_PATH ?? '/',
  server: {
    // atproto OAuth loopback mode requires the app to run on 127.0.0.1
    // (not "localhost"), so bind there by default. When Tauri targets a
    // physical iOS device (or --host), it sets TAURI_DEV_HOST to the Mac's
    // LAN IP and expects the dev server there; honor it so the device can
    // reach us. Simulator runs leave it unset → 127.0.0.1 (OAuth intact).
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: 1997,
    strictPort: true,
  },
})
