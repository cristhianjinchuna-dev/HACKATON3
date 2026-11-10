import { apiRaw } from '../lib/api'
import { ApiError } from '../lib/errors'
import { retryDelay, sleep } from '../lib/sleep'
import type { Tile } from '../lib/types'

// Bloque ya decodificado (más rápido de leer que strings/base64)
export interface TileData {
  originRow: number
  originCol: number
  rows: number
  cols: number
  values: Uint8Array   // dígitos 0-9
  tremor: Uint8Array   // 0-100
  bins: string[]       // '.', 'W', 'F', 'D', 'M'
  version: number
}

export interface CellInfo { digit: number; tremor: number; bin: string }

function decode(t: Tile): TileData {
  const values = new Uint8Array(t.values.length)
  for (let i = 0; i < t.values.length; i++) values[i] = t.values.charCodeAt(i) - 48
  const raw = atob(t.tremor)
  const tremor = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) tremor[i] = raw.charCodeAt(i)
  return {
    originRow: t.originRow,
    originCol: t.originCol,
    rows: t.rows,
    cols: t.cols,
    values,
    tremor,
    bins: t.bins.split(''),
    version: t.version,
  }
}

export const tileKey = (tr: number, tc: number) => `${tr}:${tc}`

// Límite del servidor: 40 bloques cada 10 s. Nos quedamos un poco por debajo.
const WINDOW_MS = 10_000
const MAX_PER_WINDOW = 36

interface InFlight { promise: Promise<TileData>; ctrl: AbortController; pinned: boolean }

// Caché de bloques: pide solo lo necesario, nunca dos veces el mismo a la vez,
// respeta Retry-After (429) y reintenta 503 con espera creciente.
export class TileStore {
  private readonly fileId: number
  private readonly tileSize: number
  private tiles = new Map<string, TileData>()
  private inflight = new Map<string, InFlight>()
  private blockedUntil = 0          // mientras dure un 429 NO se pide nada
  private sent: number[] = []       // tiempos de las últimas requests (ventana de 10 s)
  private listeners = new Set<() => void>()
  private frame = 0

  constructor(fileId: number, tileSize: number) {
    this.fileId = fileId
    this.tileSize = tileSize
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  // Agrupa varias notificaciones en un solo render por frame
  private emit() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.listeners.forEach((fn) => fn())
    })
  }

  // Lee una celda (coordenadas globales). null si su bloque aún no llegó.
  cell(r: number, c: number): CellInfo | null {
    const t = this.tiles.get(tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)))
    if (!t) return null
    const i = (r - t.originRow) * t.cols + (c - t.originCol)
    return { digit: t.values[i], tremor: t.tremor[i], bin: t.bins[i] }
  }

  // Espera turno: respeta Retry-After y el ritmo de 36 bloques / 10 s
  private async waitTurn(signal: AbortSignal) {
    for (;;) {
      const now = Date.now()
      if (now < this.blockedUntil) {
        await sleep(this.blockedUntil - now, signal)
        continue
      }
      this.sent = this.sent.filter((t) => now - t < WINDOW_MS)
      if (this.sent.length < MAX_PER_WINDOW) {
        this.sent.push(now)
        return
      }
      await sleep(WINDOW_MS - (now - this.sent[0]) + 50, signal)
    }
  }

  private async fetchTile(tr: number, tc: number, signal: AbortSignal): Promise<TileData> {
    const k = tileKey(tr, tc)
    for (let attempt = 0; ; attempt++) {
      await this.waitTurn(signal)
      try {
        const { data } = await apiRaw<Tile>(`/files/${this.fileId}/tiles/${tr}/${tc}`, { signal, maxRetries: 0 })
        const fresh = decode(data)
        const prev = this.tiles.get(k)
        // Una respuesta vieja nunca pisa a una más nueva
        if (!prev || fresh.version >= prev.version) {
          this.tiles.set(k, fresh)
          this.emit()
        }
        return this.tiles.get(k) ?? fresh
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          this.blockedUntil = Math.max(this.blockedUntil, Date.now() + (e.retryAfter ?? 1) * 1000)
          continue
        }
        if (e instanceof ApiError && e.status === 503 && attempt < 6) {
          await sleep(retryDelay(e.retryAfter, attempt), signal)
          continue
        }
        throw e
      }
    }
  }

  // Pide un bloque (o devuelve el de caché / el que ya está en vuelo).
  // pinned = no se cancela al salir de la vista (lo usa la selección de grupo).
  load(tr: number, tc: number, opts: { pinned?: boolean; force?: boolean } = {}): Promise<TileData> {
    const k = tileKey(tr, tc)
    const cached = this.tiles.get(k)
    if (cached && !opts.force) return Promise.resolve(cached)
    const running = this.inflight.get(k)
    if (running) {
      if (opts.pinned) running.pinned = true
      return running.promise
    }
    const ctrl = new AbortController()
    const promise = this.fetchTile(tr, tc, ctrl.signal).finally(() => {
      if (this.inflight.get(k)?.ctrl === ctrl) this.inflight.delete(k)
    })
    this.inflight.set(k, { promise, ctrl, pinned: opts.pinned ?? false })
    return promise
  }

  // Cancela los bloques que salieron de la vista antes de responder
  cancelExcept(keep: Set<string>) {
    for (const [k, entry] of this.inflight) {
      if (!entry.pinned && !keep.has(k)) {
        entry.ctrl.abort()
        this.inflight.delete(k)
      }
    }
  }

  // Tras refinar: marcamos las celdas con su caja SIN volver a pedir la grilla
  applyBin(cells: { r: number; c: number }[], letter: string) {
    const touched = new Map<string, TileData>()
    for (const { r, c } of cells) {
      const k = tileKey(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize))
      const base = touched.get(k) ?? this.tiles.get(k)
      if (!base) continue
      const t = touched.get(k) ?? { ...base, bins: [...base.bins], version: base.version + 1 }
      t.bins[(r - t.originRow) * t.cols + (c - t.originCol)] = letter
      touched.set(k, t)
    }
    touched.forEach((t, k) => this.tiles.set(k, t))
    this.emit()
  }

  dispose() {
    this.inflight.forEach((e) => e.ctrl.abort())
    this.inflight.clear()
    cancelAnimationFrame(this.frame)
  }
}
