import { api } from './api'
import { API_URL } from './config'
import { ApiError } from './errors'
import { endSession } from './session'
import { sleep } from './sleep'

// Stream de eventos (SSE) con ticket. UNA sola conexión por navegador:
// la pestaña "líder" (Web Lock) tiene la conexión y reparte los eventos a las demás (BroadcastChannel).

export interface LumonEvent { id: number; type: string; data: unknown }
export type StreamStatus = 'desconectado' | 'conectando' | 'conectado' | 'reconectando' | 'en otra pestaña' | 'cerrado'

const TYPES = [
  'refiner.updated', 'refinement.created', 'file.completed',
  'contingency.activated', 'contingency.resolved',
  'session.revoked', 'stream.reset', 'stream.superseded',
]
// Estos llevan id propio y pueden llegar duplicados: se descartan por id
const DEDUPE = new Set(['refiner.updated', 'refinement.created', 'file.completed', 'contingency.activated', 'contingency.resolved'])

type Msg = { kind: 'event'; event: LumonEvent } | { kind: 'status'; status: StreamStatus }

const channel: BroadcastChannel | null =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('lumon-events')
const eventListeners = new Set<(e: LumonEvent) => void>()
const statusListeners = new Set<(s: StreamStatus) => void>()
const seen = new Set<number>()
let status: StreamStatus = 'desconectado'
let lastEventId: number | null = null
let isLeader = false
let stopCtrl: AbortController | null = null

function setStatus(s: StreamStatus, broadcast: boolean) {
  status = s
  statusListeners.forEach((fn) => fn(s))
  if (broadcast) {
    const msg: Msg = { kind: 'status', status: s }
    channel?.postMessage(msg)
  }
}

// Entrega un evento a esta pestaña (ningún evento se aplica dos veces)
function deliver(e: LumonEvent) {
  if (DEDUPE.has(e.type) && Number.isFinite(e.id)) {
    if (seen.has(e.id)) return
    seen.add(e.id)
    if (seen.size > 3000) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    if (lastEventId === null || e.id > lastEventId) lastEventId = e.id
  }
  eventListeners.forEach((fn) => fn(e))
}

channel?.addEventListener('message', (ev) => {
  const msg = ev.data as Msg
  if (msg.kind === 'event') deliver(msg.event)
  else if (!isLeader) setStatus(msg.status, false)
})

export function onLumonEvent(fn: (e: LumonEvent) => void): () => void {
  eventListeners.add(fn)
  return () => {
    eventListeners.delete(fn)
  }
}

export function onStreamStatus(fn: (s: StreamStatus) => void): () => void {
  statusListeners.add(fn)
  fn(status)
  return () => {
    statusListeners.delete(fn)
  }
}

type End = 'opened' | 'failed' | 'final'

// Una conexión: termina por error/cierre, por 45 s sin datos (conexión muerta) o por cierre definitivo
function listen(ticket: string, signal: AbortSignal): Promise<End> {
  return new Promise((resolve) => {
    const qs = new URLSearchParams({ ticket })
    if (lastEventId !== null) qs.set('lastEventId', String(lastEventId))   // recuperar lo perdido
    const es = new EventSource(`${API_URL}/events/stream?${qs.toString()}`)
    let opened = false
    let lastData = Date.now()
    let done = false

    const finish = (r: End) => {
      if (done) return
      done = true
      es.close()   // la reconexión automática de EventSource no sirve (ticket de un solo uso)
      window.clearInterval(watchdog)
      signal.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const onAbort = () => finish('final')
    signal.addEventListener('abort', onAbort, { once: true })

    const watchdog = window.setInterval(() => {
      if (Date.now() - lastData > 45_000) finish(opened ? 'opened' : 'failed')
    }, 5000)

    es.onopen = () => {
      opened = true
      lastData = Date.now()
      setStatus('conectado', true)
    }
    es.onerror = () => finish(opened ? 'opened' : 'failed')

    for (const type of TYPES) {
      es.addEventListener(type, (ev: MessageEvent) => {
        lastData = Date.now()
        let data: unknown = null
        try {
          data = JSON.parse(String(ev.data))
        } catch {
          // sin JSON
        }
        const event: LumonEvent = { id: ev.lastEventId ? Number(ev.lastEventId) : Number.NaN, type, data }
        if (type === 'session.revoked') {
          endSession('SESSION_REVOKED')    // todas las pestañas vuelven al login
          finish('final')
          return
        }
        if (type === 'stream.superseded') {
          finish('final')
          return
        }
        const msg: Msg = { kind: 'event', event }
        channel?.postMessage(msg)          // a las demás pestañas
        deliver(event)                     // a esta pestaña
      })
    }
  })
}

// Bucle de la pestaña líder: ticket nuevo en cada conexión + espera creciente
async function runLeader(signal: AbortSignal) {
  let attempt = 0
  while (!signal.aborted) {
    setStatus(attempt === 0 ? 'conectando' : 'reconectando', true)
    try {
      const { ticket } = await api<{ ticket: string }>('/events/tickets', { method: 'POST', signal })
      const end = await listen(ticket, signal)
      if (end === 'final') {
        if (!signal.aborted) setStatus('cerrado', true)
        return
      }
      attempt = end === 'opened' ? 0 : attempt + 1
    } catch (e) {
      if (signal.aborted) return
      if (e instanceof ApiError && [401, 403, 423].includes(e.status)) {
        setStatus('cerrado', true)
        return
      }
      attempt++
    }
    setStatus('reconectando', true)
    try {
      await sleep(Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500, signal)
    } catch {
      return
    }
  }
}

export function startEvents() {
  if (stopCtrl) return
  const ctrl = new AbortController()
  stopCtrl = ctrl
  if (!('locks' in navigator)) {
    isLeader = true
    void runLeader(ctrl.signal)
    return
  }
  setStatus('en otra pestaña', false)
  // Si se cierra la pestaña líder, el lock se libera y otra pestaña retoma la conexión
  navigator.locks
    .request('lumon-events-leader', { signal: ctrl.signal }, async () => {
      isLeader = true
      try {
        await runLeader(ctrl.signal)
      } finally {
        isLeader = false
      }
    })
    .catch(() => {
      // cancelado al salir
    })
}

export function stopEvents() {
  stopCtrl?.abort()
  stopCtrl = null
  isLeader = false
  setStatus('desconectado', false)
}
