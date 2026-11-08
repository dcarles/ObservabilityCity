import { describe, expect, it } from 'vitest'
import { loadTenantView, saveTenantView, saveView, startView, viewSwitchAddress, TENANT_VIEW_KEY } from '../../src/viewMode'
import type { Store } from '../../src/lighting'

const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('startView', () => {
  it('is the town unless the address or this browser says otherwise', () => {
    expect(startView('', memory())).toBe('town')
    expect(startView('?view=dashboard', memory())).toBe('dashboard')
    const s = memory()
    saveView(s, 'dashboard')
    expect(startView('', s)).toBe('dashboard')
    expect(startView('?view=town', s)).toBe('town') // the address wins
  })

  it('ignores a view it does not know, and a wall address with no view in it is the town', () => {
    expect(startView('?view=nonsense', memory())).toBe('town')
    const s = memory()
    saveView(s, 'dashboard')
    expect(startView('?wall=1', s)).toBe('town')
  })

  it('opens the wall dashboard when the address asks for the dashboard', () => {
    expect(startView('?wall=1&view=dashboard', memory())).toBe('dashboard')
  })

  it('works when storage is blocked', () => {
    const blocked: Store = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
    expect(startView('', blocked)).toBe('town')
    expect(() => saveView(blocked, 'dashboard')).not.toThrow()
    expect(startView('', null)).toBe('town')
  })
})

describe('viewSwitchAddress', () => {
  it('keeps the rest of the address, sets the view and remembers it', () => {
    const s = memory()
    const to = viewSwitchAddress({ pathname: '/', search: '?env=staging&islands=a,b', hash: '' }, 'dashboard', s)
    expect(to).toBe('/?env=staging&islands=a,b&view=dashboard')
    expect(startView('', s)).toBe('dashboard')
  })
})

describe('the tenant choice is shared by both views', () => {
  it('is remembered and read back, and falls back to all tenants on rubbish', () => {
    const s = memory()
    saveTenantView(s, { hideTest: true, tenants: ['t1'] })
    expect(loadTenantView(s)).toEqual({ hideTest: true, tenants: ['t1'] })
    s.data.set(TENANT_VIEW_KEY, '{nope')
    expect(loadTenantView(s)).toEqual({ hideTest: false, tenants: [] })
    expect(loadTenantView(null)).toEqual({ hideTest: false, tenants: [] })
  })
})
