import { describe, expect, it } from 'vitest'
import { isExpectedSocketReset } from '../../vite.config'

describe('the dev server log', () => {
  it('drops the resets of the SignalR socket that closing a tab or restarting the backend causes', () => {
    expect(isExpectedSocketReset('\u001b[31mws proxy error:\u001b[39m\nError: read ECONNRESET\n    at TCP.onStreamRead')).toBe(true)
    expect(isExpectedSocketReset('ws proxy socket error:\nError: read ECONNRESET')).toBe(true)
  })

  it('keeps every other proxy error', () => {
    expect(isExpectedSocketReset('ws proxy error:\nError: connect ECONNREFUSED 127.0.0.1:5080')).toBe(false)
    expect(isExpectedSocketReset('http proxy error: /api/x\nError: read ECONNRESET')).toBe(false)
  })
})

describe('the build', () => {
  it('fails on a warning instead of printing it', async () => {
    const config = (await import('../../vite.config')).default as { build: { rollupOptions: { onwarn: (w: { code?: string; message: string }) => void } } }
    expect(() => config.build.rollupOptions.onwarn({ code: 'CIRCULAR_DEPENDENCY', message: 'a -> b -> a' })).toThrow('CIRCULAR_DEPENDENCY: a -> b -> a')
  })
})
