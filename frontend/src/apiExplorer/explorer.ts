// The API explorer: a big window over any view, opened from the drawer of a gateway or of a service that has an API. A tree of groups and their APIs with a search on the left, the
// selected API's operations in the middle, the selected operation with its parameters, responses and policies on the right. The data comes from /api/apis (read on demand by the
// server, kept for a while); a policy is shown as it is on the gateway with anything that looks like a secret already masked by the server.

import './explorer.css'
import { escapeHtml } from '../picker'
import type { ApiCatalogueList, ApiDetail, ApiOperationInfo, ApiPolicyInfo, ApiSummary } from '../types'
import { apisOfSystem, buildTree, filterOperations, filterTree, highlightXml, marker, methodClass, NO_FILTER, servedBy, statusClass, type ApiFilter } from './model'

export interface ExplorerOptions {
  /** The town and environment of the page, as a query string without the question mark (see scopeParams). */
  query: string
  /** The system whose API to show first; the gateway's own drawer opens the explorer with none. */
  system?: string | null
  /** What the town calls things, from its snapshot. */
  groupName: (id: string) => string
  systemName: (id: string) => string
  /** The word for a group in a sentence ("pillar"), for the search's hint. */
  groupWord: string
  vendorsLabel: string
  /** Goes to a system of the town (the drawer of the page opens on it). */
  go: (id: string) => void
}

const get = async <T>(path: string, query: string, extra: Record<string, string> = {}): Promise<T> => {
  const params = [query, ...Object.entries(extra).map(([k, v]) => `${k}=${encodeURIComponent(v)}`)].filter(Boolean).join('&')
  const r = await fetch(`${path}${params ? `?${params}` : ''}`)
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `The server answered ${r.status}.`)
  return (await r.json()) as T
}

/** The list of APIs, read once for a while: the drawer asks it to know whether a system has an API, the explorer to fill its tree. */
let cached: { key: string; at: number; list: Promise<ApiCatalogueList | null> } | null = null
const KEEP_MS = 60_000

export function loadApiList(query: string, force = false): Promise<ApiCatalogueList | null> {
  if (!force && cached && cached.key === query && Date.now() - cached.at < KEEP_MS) return cached.list
  const list = get<ApiCatalogueList>('/api/apis', query).catch(() => null)
  cached = { key: query, at: Date.now(), list }
  return list
}

/** The list as it was last read for this page, without a new read: null before the first read finished or when it failed. */
let lastList: ApiCatalogueList | null = null
export function knownApiList(): ApiCatalogueList | null {
  return lastList
}
export async function warmApiList(query: string): Promise<ApiCatalogueList | null> {
  lastList = await loadApiList(query)
  return lastList
}

export class ApiExplorer {
  private el: HTMLElement | null = null
  private list: ApiCatalogueList | null = null
  private error = ''
  private filter: ApiFilter = { ...NO_FILTER }
  private opText = ''
  private api: ApiSummary | null = null
  private detail: ApiDetail | null = null
  private detailError = ''
  private opId: string | null = null
  private readonly opPolicies = new Map<string, ApiPolicyInfo | 'loading' | 'failed'>()
  private readonly closed = new Set<string>()
  private seq = 0
  private readonly onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && this.el) { e.stopImmediatePropagation(); this.close() } }

  constructor(private readonly opt: ExplorerOptions) {}

  get isOpen(): boolean {
    return this.el !== null
  }

  async open(): Promise<void> {
    if (this.el) return
    const el = document.createElement('div')
    el.id = 'api-explorer'
    el.className = 'ae-backdrop'
    el.innerHTML = `<div class="ae-window" role="dialog" aria-modal="true" aria-label="API explorer">
      <header class="ae-head"><b>API explorer</b><span class="ae-note" id="ae-note"></span><button class="ae-close" data-ae-close title="Close (Esc)">✕</button></header>
      <div class="ae-body">
        <nav class="ae-tree"><div class="ae-search"><input type="search" id="ae-search" placeholder="Search by ${escapeHtml(this.opt.groupWord)}, service, API or address…" autocomplete="off" aria-label="Search APIs"></div>
          <div class="ae-chips" id="ae-chips"></div><div class="ae-tree-list" id="ae-tree"></div></nav>
        <section class="ae-ops" id="ae-ops"></section>
        <section class="ae-detail" id="ae-detail"></section>
      </div></div>`
    this.el = el
    document.body.appendChild(el)
    el.addEventListener('click', (e) => this.click(e.target as HTMLElement))
    el.querySelector<HTMLInputElement>('#ae-search')!.addEventListener('input', (e) => { this.filter = { ...this.filter, text: (e.target as HTMLInputElement).value }; this.drawTree() })
    window.addEventListener('keydown', this.onKey, true)
    this.drawAll()
    el.querySelector<HTMLInputElement>('#ae-search')!.focus()
    try { this.list = await loadApiList(this.opt.query, true); lastList = this.list; if (!this.list) this.error = 'The APIs could not be read.' }
    catch (e) { this.error = (e as Error).message }
    if (!this.el) return
    this.drawAll()
    const own = this.list && this.opt.system ? apisOfSystem(this.list.apis, this.opt.system) : []
    // opened from a service: only its APIs in the tree, so the one chosen is never lost in a long list
    if (own.length > 0) { this.filter = { ...this.filter, system: this.opt.system! }; this.drawTree() }
    if (own[0]) await this.select(own[0])
  }

  close(): void {
    window.removeEventListener('keydown', this.onKey, true)
    this.el?.remove()
    this.el = null
    this.seq++
  }

  private click(t: HTMLElement): void {
    if (t === this.el || t.closest('[data-ae-close]')) { this.close(); return }
    const chip = t.closest<HTMLElement>('[data-ae-chip]')
    if (chip?.dataset.aeChip === 'system') { this.filter = { ...this.filter, system: undefined }; this.drawTree(); return }
    if (chip) { const k = chip.dataset.aeChip as 'differing' | 'unlinked'; this.filter = { ...this.filter, [k]: !this.filter[k] }; this.drawTree(); return }
    const group = t.closest<HTMLElement>('[data-ae-group]')
    if (group) { const id = group.dataset.aeGroup!; if (!this.closed.delete(id)) this.closed.add(id); this.drawTree(); return }
    const api = t.closest<HTMLElement>('[data-ae-api]')
    if (api) { const found = this.list?.apis.find((a) => a.id === api.dataset.aeApi); if (found) void this.select(found); return }
    const op = t.closest<HTMLElement>('[data-ae-op]')
    if (op) { void this.pick(op.dataset.aeOp!); return }
    const go = t.closest<HTMLElement>('[data-ae-go]')
    if (go) { this.close(); this.opt.go(go.dataset.aeGo!) }
  }

  private async select(api: ApiSummary): Promise<void> {
    const seq = ++this.seq
    this.api = api
    this.detail = null
    this.detailError = ''
    this.opId = null
    this.opText = ''
    this.drawTree()
    this.drawOps()
    this.drawDetail()
    try {
      const d = await get<ApiDetail>('/api/api-detail', this.opt.query, { id: api.id })
      if (seq !== this.seq) return
      this.detail = d
    } catch (e) {
      if (seq !== this.seq) return
      this.detailError = (e as Error).message
    }
    this.drawOps()
    this.drawDetail()
  }

  private async pick(id: string): Promise<void> {
    this.opId = id
    this.drawOps()
    this.drawDetail()
    const api = this.api
    if (!api || this.opPolicies.has(`${api.id}|${id}`)) return
    const key = `${api.id}|${id}`
    this.opPolicies.set(key, 'loading')
    this.drawDetail()
    try { this.opPolicies.set(key, await get<ApiPolicyInfo>('/api/api-operation-policy', this.opt.query, { id: api.id, operation: id })) }
    catch { this.opPolicies.set(key, 'failed') }
    if (this.api === api && this.opId === id) this.drawDetail()
  }

  private q<T extends HTMLElement>(id: string): T | null {
    return this.el?.querySelector<T>(`#${id}`) ?? null
  }

  private drawAll(): void {
    this.drawNote()
    this.drawTree()
    this.drawOps()
    this.drawDetail()
  }

  private drawNote(): void {
    const n = this.q('ae-note')
    if (!n) return
    const problems = this.list?.problems ?? []
    n.textContent = this.error ? '' : this.list ? `${this.list.apis.length} API${this.list.apis.length === 1 ? '' : 's'}${problems.length ? ` · ${problems.length} problem${problems.length === 1 ? '' : 's'}` : ''} · as the gateways hold them now` : 'Reading the gateways…'
    n.title = problems.join('\n')
  }

  private drawTree(): void {
    const chips = this.q('ae-chips')
    const tree = this.q('ae-tree')
    if (!chips || !tree) return
    const only = this.filter.system ? `<button data-ae-chip="system" class="on" title="Show the APIs of every system again">Only ${escapeHtml(this.opt.systemName(this.filter.system))} ✕</button>` : ''
    chips.innerHTML = this.list?.configured
      ? `${only}<button data-ae-chip="differing" class="${this.filter.differing ? 'on' : ''}" title="Only APIs the gateways do not agree on">Differs</button><button data-ae-chip="unlinked" class="${this.filter.unlinked ? 'on' : ''}" title="Only APIs whose backend matched no service">Not linked</button>`
      : ''
    if (this.error) { tree.innerHTML = `<p class="ae-none">${escapeHtml(this.error)}</p>`; return }
    if (!this.list) { tree.innerHTML = '<p class="ae-none">Loading…</p>'; return }
    if (!this.list.configured) { tree.innerHTML = '<p class="ae-none">The API explorer is not set up for this environment. Add an <code>apis</code> block to its file (see the config reference).</p>'; return }
    const gateways = new Set(this.list.apis.flatMap((a) => a.gateways)).size
    const groups = filterTree(buildTree(this.list.apis, this.opt.groupName, this.opt.vendorsLabel), this.filter, this.opt.systemName)
    const searching = this.filter.text.trim().length > 0 || this.filter.differing || this.filter.unlinked
    const problems = this.list.problems.length ? `<p class="ae-warn">${this.list.problems.map(escapeHtml).join('<br>')}</p>` : ''
    tree.innerHTML = problems + (groups.length === 0 ? '<p class="ae-none">Nothing matches.</p>' : groups.map((g) => {
      const open = searching || !this.closed.has(g.id)
      return `<div class="ae-group" data-kind="${g.kind}"><button class="ae-group-head" data-ae-group="${escapeHtml(g.id)}" aria-expanded="${open}"><span>${open ? '▾' : '▸'}</span><span>${escapeHtml(g.name)}</span><small>${g.apis.length}</small></button>` +
        (open ? g.apis.map((a) => this.treeRow(a, gateways)).join('') : '') + '</div>'
    }).join(''))
  }

  private treeRow(a: ApiSummary, gateways: number): string {
    const m = marker(a)
    const by = servedBy(a, gateways)
    const system = a.systemId ? this.opt.systemName(a.systemId) : a.backendHost ?? ''
    return `<button class="ae-api${this.api?.id === a.id ? ' sel' : ''}" data-ae-api="${escapeHtml(a.id)}" title="${escapeHtml(a.backendUrl ?? '')}"><span class="ae-api-name">${escapeHtml(a.displayName)}</span>` +
      `<span class="ae-api-sub">${escapeHtml(system)}${by && by !== 'all' ? ` · ${escapeHtml(by)}` : ''}</span>${m ? `<span class="ae-flag" title="${escapeHtml(m)}">${escapeHtml(m)}</span>` : ''}</button>`
  }

  private drawOps(): void {
    const el = this.q('ae-ops')
    if (!el) return
    const api = this.api
    if (!api) { el.innerHTML = '<p class="ae-none">Pick an API on the left.</p>'; return }
    const where = api.systemId ? `<a class="ae-link" data-ae-go="${escapeHtml(api.systemId)}" title="Show the system in the town">${escapeHtml(this.opt.systemName(api.systemId))} ↗</a>` : api.thirdPartyId ? `<span>a third party</span>` : '<span>no system matched this backend</span>'
    const head = `<div class="ae-ops-head"><b>${escapeHtml(api.displayName)}</b><div class="ae-backend" title="The address the gateway sends the call to">${escapeHtml(api.backendUrl ?? 'no backend address')}</div><div class="ae-where">${where}</div>` +
      `<input type="search" id="ae-opsearch" placeholder="Search operations…" value="${escapeHtml(this.opText)}" aria-label="Search operations"></div>`
    if (this.detailError) { el.innerHTML = `${head}<p class="ae-none">${escapeHtml(this.detailError)}</p>`; return }
    if (!this.detail) { el.innerHTML = `${head}<p class="ae-none">Loading…</p>`; return }
    const ops = filterOperations(this.detail.operations, this.opText)
    el.innerHTML = head + (this.detail.operations.length === 0 ? '<p class="ae-none">The gateway lists no operation for this API.</p>' : ops.map((o) =>
      `<button class="ae-op${this.opId === o.id ? ' sel' : ''}" data-ae-op="${escapeHtml(o.id)}"><span class="ae-m ${methodClass(o.method)}">${escapeHtml(o.method || '?')}</span><span class="ae-op-path">${escapeHtml(o.urlTemplate)}</span><small>${escapeHtml(o.name)}</small></button>`).join(''))
    const input = el.querySelector<HTMLInputElement>('#ae-opsearch')
    input?.addEventListener('input', () => { this.opText = input.value; this.redrawOpsKeepingFocus() })
  }

  private redrawOpsKeepingFocus(): void {
    this.drawOps()
    const input = this.q<HTMLInputElement>('ae-opsearch')
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }
  }

  private drawDetail(): void {
    const el = this.q('ae-detail')
    if (!el) return
    const d = this.detail
    if (!this.api || !d) { el.innerHTML = this.api && !this.detailError ? '<p class="ae-none">Loading…</p>' : ''; return }
    const notes = d.differences.length ? `<div class="ae-diff"><b>Differs between gateways</b>${d.differences.map((x) => `<div>${escapeHtml(x)}</div>`).join('')}</div>` : ''
    const op = this.opId ? d.operations.find((o) => o.id === this.opId) ?? null : null
    el.innerHTML = notes + (op ? this.operation(op) : '<p class="ae-none">Pick an operation to see its call and responses.</p>') + this.policies(op)
  }

  private operation(o: ApiOperationInfo): string {
    const rows = o.parameters.map((p) => `<tr><td class="mono">${escapeHtml(p.name)}</td><td>${escapeHtml(p.in)}</td><td>${escapeHtml(p.type ?? '')}</td><td>${p.required ? 'required' : ''}</td></tr>`).join('')
    return `<div class="ae-sec"><div class="ae-call"><span class="ae-m ${methodClass(o.method)}">${escapeHtml(o.method || '?')}</span> <b class="mono">${escapeHtml(o.urlTemplate)}</b></div>` +
      `<div class="ae-sub">${escapeHtml(o.name)}${o.description ? ` · ${escapeHtml(o.description)}` : ''}</div></div>` +
      `<div class="ae-sec"><h4>Parameters</h4>${rows ? `<table><thead><tr><th>Name</th><th>In</th><th>Type</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="ae-none">None.</p>'}</div>` +
      `<div class="ae-sec"><h4>Responses</h4>${o.responses.length ? o.responses.map((c) => `<span class="ae-status ${statusClass(c)}">${c}</span>`).join(' ') : '<p class="ae-none">The gateway lists none.</p>'}</div>`
  }

  /** The policies in force on the selected operation: the API's own, then the operation's, each as the gateway holds it. */
  private policies(op: ApiOperationInfo | null): string {
    const d = this.detail!
    const block = (title: string, p: ApiPolicyInfo | undefined | 'loading' | 'failed'): string => {
      if (p === 'loading') return `<div class="ae-sec"><h4>${title}</h4><p class="ae-none">Loading…</p></div>`
      if (p === 'failed') return `<div class="ae-sec"><h4>${title}</h4><p class="ae-none">Could not be read.</p></div>`
      if (!p || !p.xml) return `<div class="ae-sec"><h4>${title}</h4><p class="ae-none">None set here: the gateway's own policy applies.</p></div>`
      const fragments = p.fragments.map((f) => `<details class="ae-fragment"><summary>Fragment <code>${escapeHtml(f.id)}</code></summary>${f.xml ? `<pre>${highlightXml(f.xml)}</pre>` : '<p class="ae-none">Could not be read.</p>'}</details>`).join('')
      return `<div class="ae-sec"><h4>${title}</h4><pre>${highlightXml(p.xml)}</pre>${fragments}</div>`
    }
    const own = this.opId && this.api ? this.opPolicies.get(`${this.api.id}|${this.opId}`) : undefined
    return block('Policy on the API', d.policy) + (op ? block('Policy on this operation', own) : '')
  }
}
