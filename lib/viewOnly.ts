// VIEW-ONLY MODE in the browser (10/11/2026, the Drummond accounts). The real lock is the DATABASE (restrictive policies on
// every table + storage) and the API gate (lib/viewer.server) — this file only makes the screen honest instead of failing
// half-way: a VIEW ONLY bar, every field read-only, and any write attempt stopped here with a clear message.
let on = false
const listeners = new Set<(m: string) => void>()

export const isViewOnly = () => on
export function setViewOnly(v: boolean) {
  on = v
  if (typeof window === 'undefined') return
  if (v) { patchWindowFetch(); lockFields() }
}
export function onViewOnlyBlock(fn: (m: string) => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
const MSG = 'VIEW ONLY — nothing was changed.'
const notify = () => listeners.forEach(fn => fn(MSG))
const denied = () => new Response(JSON.stringify({ error: MSG, message: MSG, code: 'VIEW_ONLY' }), { status: 403, headers: { 'Content-Type': 'application/json' } })

const methodOf = (input: RequestInfo | URL, init?: RequestInit) =>
  String(init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase()
const urlOf = (input: RequestInfo | URL) => typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url

/** the supabase-js client's fetch: in view-only, table writes and storage writes stop here (RPC reads and auth pass). */
export function viewOnlyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (on) {
    const m = methodOf(input, init), u = urlOf(input)
    const write = m !== 'GET' && m !== 'HEAD'
    const table = /\/rest\/v1\/(?!rpc\/)/.test(u)
    const storage = /\/storage\/v1\/object\//.test(u) && !/\/object\/(sign|list|info|public|authenticated)\//.test(u)
    if (write && (table || storage)) { notify(); return Promise.resolve(denied()) }
  }
  return fetch(input, init)
}

let patched = false
function patchWindowFetch() {
  if (patched) return
  patched = true
  const orig = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (on) {
      const m = methodOf(input, init), u = urlOf(input)
      // this app's own API: anything but GET changes something or sends something out of the house
      if (m !== 'GET' && m !== 'HEAD' && /\/api\//.test(u) && !/supabase\.co\//.test(u)) { notify(); return Promise.resolve(denied()) }
    }
    return orig(input, init)
  }
}

let observer: MutationObserver | null = null
// fields lock on the EDIT / NEW screens; elsewhere (lists with search boxes, filters) typing stays free and a save is what stops
const editScreen = () => /\/(edit|new|create)(\/|$)/.test(window.location.pathname)
function lockOne(el: Element) {
  if (!editScreen()) return
  if (el instanceof HTMLInputElement) {
    if (['checkbox', 'radio', 'file', 'range', 'color'].includes(el.type)) el.disabled = true
    else if (!['button', 'submit', 'reset', 'hidden'].includes(el.type)) el.readOnly = true
  } else if (el instanceof HTMLTextAreaElement) el.readOnly = true
  else if (el instanceof HTMLSelectElement) el.disabled = true
  else if (el instanceof HTMLElement && el.isContentEditable) el.contentEditable = 'false'
}
function lockFields() {
  if (observer) return
  const sweep = (root: ParentNode) => root.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach(lockOne)
  sweep(document)
  observer = new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n instanceof Element) { lockOne(n); sweep(n) } })))
  observer.observe(document.body, { childList: true, subtree: true })
}
