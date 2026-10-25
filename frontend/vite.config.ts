import { defineConfig } from 'vite'

// Under Aspire the backend address arrives as services__host__http__0; otherwise the Host project's default port.
const backend = process.env.services__host__http__0 ?? 'http://localhost:5080'

export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 5173),
    proxy: {
      '/api': backend,
      '/hubs': { target: backend, ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 1200 },
  // the browser tests in tests/e2e/ run under Playwright, not Vitest
  test: { include: ['tests/unit/**/*.test.ts'] },
})
