import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  // GitHub Pages project pages serve under /<repo>/. Set BASE_PATH at build
  // time (the deploy workflow does); dev stays at root.
  base: process.env.BASE_PATH ?? '/',
  server: {
    // atproto OAuth loopback mode requires the app to run on 127.0.0.1
    // (not "localhost"), so bind there explicitly.
    host: '127.0.0.1',
    port: 1997,
    strictPort: true,
  },
})
