import { afterEach, describe, expect, it } from 'vitest'
import { assign } from '../../src/themes/active'

describe('assign', () => {
  afterEach(() => {
    delete (Object.prototype as any).polluted
  })

  it('merges nested objects in place and copies arrays', () => {
    const inner = { a: 1, b: 2 }
    const into: any = { inner, list: [1] }
    const list = [3, 4]
    assign(into, { inner: { b: 5, c: 6 }, list })
    expect(into.inner).toBe(inner)
    expect(inner).toEqual({ a: 1, b: 5, c: 6 })
    expect(into.list).toEqual([3, 4])
    expect(into.list).not.toBe(list)
  })

  it('ignores __proto__, constructor and prototype keys', () => {
    const into: any = { inner: {} }
    assign(into, JSON.parse('{"__proto__":{"polluted":true},"inner":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}},"prototype":{"x":1}}'))
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(into, 'prototype')).toBe(false)
    expect(Object.keys(into.inner)).toEqual([])
  })
})
