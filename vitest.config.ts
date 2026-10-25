import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The Loader composition spec mounts this package by name; resolve it to source.
    alias: { 'dsh-llm-key-pool': fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  },
  test: {
    // Process the Loader and Include through Vite so their dynamic plugin imports see the alias above.
    server: { deps: { inline: [/@deepseek-ai\/cordis-plugin-(loader|include)/] } },
    include: ['tests/**/*.spec.ts'],
  },
})
