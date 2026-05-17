import { defineConfig } from 'vite';

export default defineConfig({
  base: '/APP-WFRC-Commute-Patterns/',
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          deckgl: ['@deck.gl/core', '@deck.gl/layers', '@deck.gl/mapbox'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
