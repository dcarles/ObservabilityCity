import { describe, expect, it } from 'vitest'
import { apisOfSystem, buildTree, filterOperations, filterTree, fragmentIds, highlightXml, marker, methodClass, NO_FILTER, servedBy, statusClass, UNLINKED_GROUP, VENDORS_GROUP } from '../../src/apiExplorer/model'
import type { ApiSummary } from '../../src/types'

const api = (id: string, extra: Partial<ApiSummary> = {}): ApiSummary => ({
  id, name: id, displayName: id, path: null, backendUrl: `https://${id}.example.test/`, backendHost: `${id}.example.test`, gateways: ['north', 'west'], missingFrom: [],
  systemId: null, groupId: null, thirdPartyId: null, ...extra,
})

const apis = [
  api('orders-api', { systemId: 'sales.orders', groupId: 'sales' }),
  api('basket-api', { systemId: 'sales.basket', groupId: 'sales', missingFrom: ['west'] }),
  api('billing-api', { systemId: 'pay.billing', groupId: 'pay' }),
  api('card-processor', { thirdPartyId: 'ext.cards' }),
  api('legacy-bridge'),
]
const name = (id: string): string => ({ sales: 'Sales', pay: 'Payments' })[id] ?? id
const system = (id: string): string => ({ 'sales.orders': 'Orders', 'sales.basket': 'Basket', 'pay.billing': 'Billing' })[id] ?? id

describe('the API tree', () => {
  it('groups the APIs by the island their system is on, then third parties, then the ones nothing matched', () => {
    const tree = buildTree(apis, name)
    expect(tree.map((g) => g.id)).toEqual(['pay', 'sales', VENDORS_GROUP, UNLINKED_GROUP])
    expect(tree.map((g) => g.name)).toEqual(['Payments', 'Sales', 'Third parties', 'Not linked to a service'])
    expect(tree[1]!.apis.map((a) => a.id)).toEqual(['basket-api', 'orders-api'])
  })

  it('uses the words it is given for the two groups that are not islands', () => {
    expect(buildTree(apis, name, 'Vendors', 'Unmatched').map((g) => g.name).slice(2)).toEqual(['Vendors', 'Unmatched'])
  })

  it('leaves out a group with no API', () => {
    expect(buildTree([apis[0]!], name).map((g) => g.id)).toEqual(['sales'])
  })
})

describe('the search', () => {
  const tree = buildTree(apis, name)
  it('needs every word, in the API name, its address, its system or its group', () => {
    expect(filterTree(tree, { ...NO_FILTER, text: 'sales' }, system).flatMap((g) => g.apis.map((a) => a.id))).toEqual(['basket-api', 'orders-api'])
    expect(filterTree(tree, { ...NO_FILTER, text: 'orders example' }, system).flatMap((g) => g.apis.map((a) => a.id))).toEqual(['orders-api'])
    expect(filterTree(tree, { ...NO_FILTER, text: 'billing' }, system).map((g) => g.id)).toEqual(['pay'])
    expect(filterTree(tree, { ...NO_FILTER, text: 'zzz' }, system)).toEqual([])
  })
  it('finds an API by the name of its system when the API is named differently', () => {
    expect(filterTree(buildTree([api('x1', { systemId: 'sales.orders', groupId: 'sales' })], name), { ...NO_FILTER, text: 'orders' }, system)).toHaveLength(1)
  })
  it('narrows to the APIs the gateways differ on, or to those nothing matched', () => {
    expect(filterTree(tree, { ...NO_FILTER, differing: true }, system).flatMap((g) => g.apis.map((a) => a.id))).toEqual(['basket-api'])
    expect(filterTree(tree, { ...NO_FILTER, unlinked: true }, system).flatMap((g) => g.apis.map((a) => a.id))).toEqual(['legacy-bridge'])
  })
})

describe('what the explorer says about an API', () => {
  it('finds the APIs of one system', () => {
    expect(apisOfSystem(apis, 'sales.orders').map((a) => a.id)).toEqual(['orders-api'])
    expect(apisOfSystem(apis, 'nobody')).toEqual([])
  })
  it('says where an API is missing, and nothing when every gateway has it', () => {
    expect(marker(apis[1]!)).toBe('Not on west')
    expect(marker(apis[0]!)).toBeNull()
  })
  it('names the gateways that serve an API only when there are several to tell apart', () => {
    expect(servedBy(apis[0]!, 1)).toBeNull()
    expect(servedBy(apis[0]!, 2)).toBe('all')
    expect(servedBy(api('x', { gateways: ['west'] }), 2)).toBe('west')
  })
  it('colours methods and status codes by family', () => {
    expect(['GET', 'post', 'Delete', 'TRACE'].map(methodClass)).toEqual(['get', 'post', 'delete', 'other'])
    expect([204, 302, 404, 503, 99].map(statusClass)).toEqual(['ok', 'redirect', 'client', 'server', 'other'])
  })
  it('filters operations by method, name or address', () => {
    const ops = [
      { id: 'a', name: 'GetOrder', method: 'GET', urlTemplate: '/orders/{id}', parameters: [], responses: [] },
      { id: 'b', name: 'AddOrder', method: 'POST', urlTemplate: '/orders', parameters: [], responses: [] },
    ]
    expect(filterOperations(ops, 'post').map((o) => o.id)).toEqual(['b'])
    expect(filterOperations(ops, 'orders {id}').map((o) => o.id)).toEqual(['a'])
    expect(filterOperations(ops, '').length).toBe(2)
  })
})

describe('policy XML', () => {
  it('escapes everything before colouring, so a policy is never read as markup', () => {
    const html = highlightXml('<set-header name="x"><value><script>alert(1)</script></value></set-header>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;<span class="x-tag">script</span>&gt;')
    expect(html).toContain('<span class="x-attr">name</span>=<span class="x-val">&quot;x&quot;</span>')
  })
  it('lists the fragments a policy includes, each once, never a named-value reference', () => {
    expect(fragmentIds('<inbound><include-fragment fragment-id="a" /><include-fragment fragment-id="a"/><include-fragment fragment-id="{{b}}"/><include-fragment fragment-id="c"/></inbound>')).toEqual(['a', 'c'])
    expect(fragmentIds(null)).toEqual([])
  })
})
