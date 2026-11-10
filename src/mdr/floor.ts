import { api } from '../lib/api'
import { WS_URL } from '../lib/config'

// Cliente del piso compartido (WebSocket nativo). Guarda presentes, reservas y cursores fuera de React:
// los cursores tienen su propio canal de suscripción para NO volver a renderizar la grilla.

export interface Pos { r: number; c: number }
export interface Member { userId: number; displayName: string }
export interface Claim { claimId: string; userId: number; displayName: string; cells: Pos[]; expiresAt: string }
export class ClaimDenied extends Error {
  readonly holder: string | null
  constructor(reason: string, holder: string | null) {
    super(reason)
    this.holder = holder
  }
}

interface Incoming {
  type?: string; seq?: number; requestId?: string; claimId?: string; userId?: number; displayName?: string
  r?: number | null; c?: number | null; cells?: Pos[]; expiresAt?: string; reason?: string
  holder?: { userId: number; displayName: string } | null
  members?: (Member & { r: number | null; c: number | null })[]; claims?: Claim[]
}

const FINAL = new Set([4400, 4403, 4404, 4423])   // definitivos: no reconectar

export class FloorClient {
  status = 'conectando'
  members = new Map<number, Member>()
  claims = new Map<string, Claim>()
  cursors = new Map<number, Pos>()
  myClaim: Claim | null = null

  private readonly fileId: number
  private readonly myUserId: number
  private ws: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private ticketFails = 0
  private seq = -1
  private missedPongs = 0
  private pingTimer = 0
  private renewTimer = 0
  private retryTimer = 0
  private lastCursorAt = 0
  private cursorTimer = 0
  private pendingCursor: Pos | null = null
  private requestN = 0
  private pending = new Map<string, { resolve: (c: Claim) => void; reject: (e: Error) => void; timer: number }>()
  private stateListeners = new Set<() => void>()
  private cursorListeners = new Set<() => void>()

  constructor(fileId: number, myUserId: number) {
    this.fileId = fileId
    this.myUserId = myUserId
    void this.connect()
  }

  onState(fn: () => void) { this.stateListeners.add(fn); return () => { this.stateListeners.delete(fn) } }
  onCursors(fn: () => void) { this.cursorListeners.add(fn); return () => { this.cursorListeners.delete(fn) } }
  private emitState() { this.stateListeners.forEach((f) => f()) }
  private emitCursors() { this.cursorListeners.forEach((f) => f()) }
  private setStatus(s: string) { this.status = s; this.emitState() }
  get connected() { return this.ws?.readyState === WebSocket.OPEN }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private async connect() {
    if (this.stopped) return
    this.setStatus(this.attempt ? 'reconectando' : 'conectando')
    let ticket: string
    try {
      ticket = (await api<{ ticket: string }>('/floor/tickets', { method: 'POST', body: { fileId: this.fileId } })).ticket
    } catch {
      this.schedule(Math.min(30_000, 1000 * 2 ** this.attempt++))
      return
    }
    if (this.stopped) return
    const ws = new WebSocket(`${WS_URL}/floor/ws?ticket=${encodeURIComponent(ticket)}`)   // ticket nuevo por conexión
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.ticketFails = 0
      this.missedPongs = 0
      this.setStatus('conectado')
      this.pingTimer = window.setInterval(() => {
        if (this.missedPongs >= 2) { ws.close(); return }   // dos pong sin llegar: conexión muerta
        this.missedPongs++
        this.send({ type: 'ping', t: Date.now() })
      }, 10_000)
    }
    ws.onmessage = (ev) => {
      let m: Incoming
      try { m = JSON.parse(String(ev.data)) as Incoming } catch { return }
      this.handle(m)
    }
    ws.onclose = (ev) => {
      window.clearInterval(this.pingTimer)
      window.clearInterval(this.renewTimer)
      // al cortarse, las reservas se liberan: no quedan fantasmas
      this.members.clear(); this.claims.clear(); this.cursors.clear(); this.myClaim = null; this.seq = -1
      this.pending.forEach((p) => { window.clearTimeout(p.timer); p.reject(new Error('desconectado')) })
      this.pending.clear()
      this.emitCursors()
      if (this.stopped) return
      if (FINAL.has(ev.code)) { this.setStatus(`cerrado (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`); return }
      if (ev.code === 4401 && ++this.ticketFails > 1) { this.setStatus('cerrado (ticket inválido)'); return }
      if (ev.code === 4429) { this.schedule(10_000); return }
      this.schedule(Math.min(30_000, 1000 * 2 ** this.attempt++))
    }
  }

  private schedule(ms: number) {
    this.setStatus('reconectando')
    this.retryTimer = window.setTimeout(() => void this.connect(), ms)
  }

  private handle(m: Incoming) {
    if (m.type === 'pong') { this.missedPongs = 0; return }
    if (m.type === 'cursor') {
      if (m.userId !== undefined && m.userId !== this.myUserId && typeof m.r === 'number' && typeof m.c === 'number') {
        this.cursors.set(m.userId, { r: m.r, c: m.c })
        this.emitCursors()
      }
      return
    }
    if (m.type === 'snapshot') {
      this.seq = m.seq ?? -1
      this.members.clear(); this.claims.clear(); this.cursors.clear()
      for (const x of m.members ?? []) {
        this.members.set(x.userId, { userId: x.userId, displayName: x.displayName })   // sin duplicados
        if (x.userId !== this.myUserId && x.r !== null && x.c !== null) this.cursors.set(x.userId, { r: x.r, c: x.c })
      }
      for (const cl of m.claims ?? []) this.claims.set(cl.claimId, cl)
      if (this.myClaim && !this.claims.has(this.myClaim.claimId)) this.myClaim = null
      this.emitState(); this.emitCursors()
      return
    }
    if (m.type === 'claim.denied') {
      const p = m.requestId ? this.pending.get(m.requestId) : undefined
      if (p && m.requestId) {
        window.clearTimeout(p.timer); this.pending.delete(m.requestId)
        p.reject(new ClaimDenied(m.reason ?? 'DENIED', m.holder?.displayName ?? null))
      }
      return
    }
    // Mensajes con seq: si hay un salto, se perdió algo -> resync
    if (typeof m.seq === 'number') {
      if (this.seq >= 0 && m.seq !== this.seq + 1) { this.send({ type: 'resync' }); return }
      this.seq = m.seq
    }
    if (m.type === 'member.joined' && m.userId !== undefined) {
      this.members.set(m.userId, { userId: m.userId, displayName: m.displayName ?? '' })
    } else if (m.type === 'member.left' && m.userId !== undefined) {
      this.members.delete(m.userId); this.cursors.delete(m.userId); this.emitCursors()
    } else if ((m.type === 'claim.granted' || m.type === 'claim.updated') && m.claimId) {
      const claim: Claim = { claimId: m.claimId, userId: m.userId ?? 0, displayName: m.displayName ?? '', cells: m.cells ?? [], expiresAt: m.expiresAt ?? '' }
      this.claims.set(m.claimId, claim)
      if (m.type === 'claim.granted') {
        this.myClaim = claim
        const p = m.requestId ? this.pending.get(m.requestId) : undefined
        if (p && m.requestId) { window.clearTimeout(p.timer); this.pending.delete(m.requestId); p.resolve(claim) }
        // renovar mientras dure (vence a los 15 s)
        window.clearInterval(this.renewTimer)
        this.renewTimer = window.setInterval(() => {
          if (this.myClaim) this.send({ type: 'renew', claimId: this.myClaim.claimId })
        }, 8000)
      }
    } else if (m.type === 'claim.released' && m.claimId) {
      this.claims.delete(m.claimId)
      if (this.myClaim?.claimId === m.claimId) { this.myClaim = null; window.clearInterval(this.renewTimer) }
    }
    this.emitState()
  }

  // Reserva el grupo de esa celda. Resuelve con la reserva o rechaza con ClaimDenied.
  claim(r: number, c: number): Promise<Claim> {
    if (!this.connected) return Promise.reject(new Error('sin conexión'))
    const requestId = `req-${++this.requestN}`
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(requestId); reject(new Error('sin respuesta')) }, 6000)
      this.pending.set(requestId, { resolve, reject, timer })
      this.send({ type: 'claim', requestId, r, c })
    })
  }

  release() {
    if (this.myClaim) {
      this.send({ type: 'release', claimId: this.myClaim.claimId })
      this.claims.delete(this.myClaim.claimId)
      this.myClaim = null
      window.clearInterval(this.renewTimer)
      this.emitState()
    }
  }

  // Máximo 10 por segundo, y una pestaña oculta no envía nada
  sendCursor(r: number, c: number) {
    if (document.hidden) return
    this.pendingCursor = { r, c }
    const wait = 100 - (Date.now() - this.lastCursorAt)
    if (wait <= 0) this.flushCursor()
    else if (!this.cursorTimer) this.cursorTimer = window.setTimeout(() => this.flushCursor(), wait)
  }

  private flushCursor() {
    this.cursorTimer = 0
    if (!this.pendingCursor || document.hidden) return
    this.lastCursorAt = Date.now()
    this.send({ type: 'cursor', ...this.pendingCursor })
    this.pendingCursor = null
  }

  // Reservas de OTROS usuarios: id de celda -> nombre de quien la tiene
  othersClaimedCells(cols: number): Map<number, string> {
    const map = new Map<number, string>()
    for (const cl of this.claims.values()) {
      if (cl.userId === this.myUserId) continue
      const name = cl.displayName || this.members.get(cl.userId)?.displayName || 'otro usuario'
      for (const p of cl.cells) map.set(p.r * cols + p.c, name)
    }
    return map
  }

  close() {
    this.stopped = true
    this.release()
    window.clearTimeout(this.retryTimer)
    window.clearInterval(this.pingTimer)
    window.clearInterval(this.renewTimer)
    window.clearTimeout(this.cursorTimer)
    this.ws?.close()
  }
}
