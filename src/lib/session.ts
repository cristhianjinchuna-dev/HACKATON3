import { API_URL, BUILD } from './config'
import { toApiError } from './errors'
import { retryDelay, sleep } from './sleep'
import type { TokenPair } from './types'

// accessToken: SOLO en memoria (variable del módulo). Nunca en localStorage.
let accessToken: string | null = null
// refreshToken: se puede persistir (README). Es de UN SOLO USO.
const RT_KEY = 'lumon.refreshToken'

// Un solo refresh en vuelo por pestaña (single-flight)
let refreshing: Promise<string> | null = null

export type SessionEnd = { type: 'logout' } | { type: 'revoked'; reason: string }
type Msg = { type: 'tokens'; accessToken: string } | SessionEnd

// Canal entre pestañas: comparte el token nuevo y avisa logout/revocación
const channel: BroadcastChannel | null =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('lumon-session')

const listeners = new Set<(e: SessionEnd) => void>()

channel?.addEventListener('message', (ev) => {
  const msg = ev.data as Msg
  if (msg.type === 'tokens') {
    accessToken = msg.accessToken          // otra pestaña renovó: usamos su token
  } else {
    accessToken = null                     // otra pestaña cerró o revocó la sesión
    listeners.forEach((fn) => fn(msg))
  }
})

export function onSessionEnd(fn: (e: SessionEnd) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getAccessToken(): string | null {
  return accessToken
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(RT_KEY)
  } catch {
    return null
  }
}

function saveRefreshToken(rt: string | null) {
  try {
    if (rt) localStorage.setItem(RT_KEY, rt)
    else localStorage.removeItem(RT_KEY)
  } catch {
    // navegador sin storage
  }
}

export function setTokens(pair: TokenPair) {
  accessToken = pair.accessToken
  saveRefreshToken(pair.refreshToken)
  const msg: Msg = { type: 'tokens', accessToken: pair.accessToken }
  channel?.postMessage(msg)
}

// Sesión revocada (REFRESH_REUSED, SESSION_REVOKED, TOKEN_INVALID): limpiar y avisar a todos
export function endSession(reason: string) {
  accessToken = null
  saveRefreshToken(null)
  const msg: SessionEnd = { type: 'revoked', reason }
  channel?.postMessage(msg)
  listeners.forEach((fn) => fn(msg))
}

// Web Locks: solo UNA pestaña a la vez puede usar el refresh token
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!('locks' in navigator)) return fn()
  let result!: T
  await navigator.locks.request('lumon-refresh', async () => {
    result = await fn()
  })
  return result
}

async function doRefresh(failedToken: string | null): Promise<string> {
  // Mientras esperábamos el lock, otra pestaña pudo renovar y mandarnos su token
  if (accessToken !== null && accessToken !== failedToken) return accessToken

  for (let attempt = 0; ; attempt++) {
    const rt = getRefreshToken()     // siempre el más reciente (lo escriben todas las pestañas)
    if (!rt) throw new Error('No hay sesión')
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lumon-Build': BUILD },
      body: JSON.stringify({ refreshToken: rt }),
    })
    if (res.ok) {
      const pair = (await res.json()) as TokenPair
      setTokens(pair)
      return pair.accessToken
    }
    const err = await toApiError(res)
    // Modo caos: 429/503 -> esperar Retry-After y reintentar
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await sleep(retryDelay(err.retryAfter, attempt))
      continue
    }
    if (res.status === 401) endSession(err.code)   // REFRESH_REUSED, etc. -> al login
    throw err
  }
}

// Todas las requests con TOKEN_EXPIRED comparten ESTA misma promesa
export function refreshAccessToken(failedToken: string | null): Promise<string> {
  refreshing ??= withLock(() => doRefresh(failedToken)).finally(() => {
    refreshing = null
  })
  return refreshing
}

// Al recargar la página: si hay refresh token, conseguimos un access token nuevo
export async function restoreSession(): Promise<boolean> {
  if (accessToken) return true
  if (!getRefreshToken()) return false
  await refreshAccessToken(null)
  return true
}

// Logout: revoca en el servidor y avisa a las demás pestañas
export async function logout(): Promise<void> {
  await withLock(async () => {
    const rt = getRefreshToken()
    accessToken = null
    saveRefreshToken(null)
    const msg: SessionEnd = { type: 'logout' }
    channel?.postMessage(msg)
    if (!rt) return
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Lumon-Build': BUILD },
        body: JSON.stringify({ refreshToken: rt }),
      })
    } catch {
      // aunque falle la red, localmente ya cerramos
    }
  })
}