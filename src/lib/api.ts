import { API_URL, BUILD } from './config'
import { toApiError } from './errors'
import { endSession, getAccessToken, getRefreshToken, refreshAccessToken } from './session'
import { retryDelay, sleep } from './sleep'

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  auth?: boolean                       // false en login/register/health
  headers?: Record<string, string>     // ej: Idempotency-Key, If-Match
  maxRetries?: number                  // reintentos por 429/503
}

export interface ApiResult<T> { data: T; status: number; headers: Headers }

const SESSION_ERRORS = ['TOKEN_INVALID', 'SESSION_REVOKED', 'REFRESH_REUSED']

// fetch central: cabeceras, refresh coordinado, Retry-After y errores
export async function apiRaw<T>(path: string, opts: ApiOptions = {}): Promise<ApiResult<T>> {
  const { method = 'GET', body, signal, auth = true, headers = {}, maxRetries = 4 } = opts
  let refreshed = false
  let attempt = 0

  for (;;) {
    // Pestaña recién abierta sin access token pero con refresh token
    if (auth && getAccessToken() === null && getRefreshToken() !== null) {
      await refreshAccessToken(null)
    }
    const token = auth ? getAccessToken() : null

    const h: Record<string, string> = { 'X-Lumon-Build': BUILD, ...headers }
    if (body !== undefined) h['Content-Type'] = 'application/json'
    if (token) h.Authorization = `Bearer ${token}`

    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })

    if (res.ok) {
      const data: unknown = res.status === 204 ? undefined : await res.json()
      return { data: data as T, status: res.status, headers: res.headers }
    }

    const err = await toApiError(res)

    if (res.status === 401 && auth) {
      // ÚNICO caso que justifica refresh. Se reintenta UNA sola vez.
      if (err.code === 'TOKEN_EXPIRED' && !refreshed) {
        refreshed = true
        await refreshAccessToken(token)
        continue
      }
      if (SESSION_ERRORS.includes(err.code)) endSession(err.code)
      throw err
    }

    // 429 / 503: esperar lo que diga Retry-After (con espera creciente)
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      await sleep(retryDelay(err.retryAfter, attempt), signal)
      attempt++
      continue
    }

    throw err
  }
}

// Atajo cuando solo necesitamos el body
export async function api<T>(path: string, opts?: ApiOptions): Promise<T> {
  return (await apiRaw<T>(path, opts)).data
}