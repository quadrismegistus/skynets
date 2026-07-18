import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
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
