import { createLogger } from 'vite'
import { defineConfig } from 'vitest/config'

// Under Aspire the backend address arrives as services__host__http__0; otherwise the Host project's default port.
const backend = process.env.services__host__http__0 ?? 'http://localhost:5080'

// A browser tab that closes, or a backend that restarts, resets the SignalR socket the dev proxy carries. Vite logs each reset as two red errors
// with a stack trace; it is expected, so those (and only those) are dropped. Every other proxy error still shows.
export const isExpectedSocketReset = (message: string): boolean => /ws proxy (socket )?error:/.test(message) && /ECONNRESET/.test(message)

const logger = createLogger()
const logError = logger.error.bind(logger)
logger.error = (message, options) => { if (!isExpectedSocketReset(message)) logError(message, options) }

export default defineConfig({
  customLogger: logger,
  server: {
    port: Number(process.env.PORT ?? 5173),
    proxy: {
      '/api': backend,
      '/hubs': { target: backend, ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    // warnings are errors: a build that warns (a missing export, a circular import, an unresolved import) fails instead of scrolling past
    rollupOptions: { onwarn: (warning) => { throw new Error(`${warning.code ?? 'warning'}: ${warning.message}`) } },
  },
  // the browser tests in tests/e2e/ run under Playwright, not Vitest
  test: { include: ['tests/unit/**/*.test.ts'] },
})
