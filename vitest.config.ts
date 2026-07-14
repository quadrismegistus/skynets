import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  // The svelte plugin compiles `.svelte.ts` rune modules (e.g. the digest
  // engine) so `$state` works under test.
  plugins: [svelte({ hot: false })],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Rune modules need the browser-condition svelte runtime.
    server: { deps: { inline: [/svelte/] } },
  },
  resolve: { conditions: ['browser'] },
})
