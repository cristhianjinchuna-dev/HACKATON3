import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { logout as logoutSession, onSessionEnd, restoreSession, setTokens } from '../lib/session'
import type { LoginResponse, Me, Permission, RegisterResponse } from '../lib/types'

type Status = 'checking' | 'anon' | 'auth'

interface AuthValue {
  status: Status
  me: Me | null
  notice: string | null                       // mensaje para el login (sesión revocada, etc.)
  login: (email: string, password: string) => Promise<void>
  register: (teamName: string, email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  can: (p: Permission) => boolean             // la UI se decide por permissions
}

const AuthContext = createContext<AuthValue | null>(null)

const REASONS: Record<string, string> = {
  REFRESH_REUSED: 'Tu sesión fue revocada por seguridad (se reutilizó un refresh token). Inicia sesión de nuevo.',
  SESSION_REVOKED: 'Tu sesión fue revocada. Inicia sesión de nuevo.',
  TOKEN_INVALID: 'Tu sesión ya no es válida. Inicia sesión de nuevo.',
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking')
  const [me, setMe] = useState<Me | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let alive = true

    // Si otra pestaña cierra sesión o la sesión se revoca -> al login con mensaje
    const off = onSessionEnd((e) => {
      setMe(null)
      setStatus('anon')
      setNotice(
        e.type === 'logout'
          ? 'Se cerró la sesión en otra pestaña.'
          : (REASONS[e.reason] ?? 'Tu sesión terminó. Inicia sesión de nuevo.'),
      )
    })

    // Restaurar sesión al recargar (mientras tanto status = 'checking', NO se muestra el login)
    restoreSession()
      .then(async (ok) => {
        if (!ok) {
          if (alive) setStatus('anon')
          return
        }
        const data = await api<Me>('/auth/me')
        if (alive) {
          setMe(data)
          setStatus('auth')
        }
      })
      .catch(() => {
        if (alive) setStatus('anon')
      })

    return () => {
      alive = false
      off()
    }
  }, [])

  const loadMe = useCallback(async () => {
    const data = await api<Me>('/auth/me')
    setMe(data)
    setNotice(null)
    setStatus('auth')
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await api<LoginResponse>('/auth/login', { method: 'POST', body: { email, password }, auth: false })
      setTokens(r)
      await loadMe()
    },
    [loadMe],
  )

  const register = useCallback(
    async (teamName: string, email: string, password: string) => {
      const r = await api<RegisterResponse>('/auth/register', {
        method: 'POST',
        body: { teamName, email, password },
        auth: false,
      })
      setTokens(r)
      await loadMe()
    },
    [loadMe],
  )

  const logout = useCallback(async () => {
    await logoutSession()
    setMe(null)
    setNotice(null)
    setStatus('anon')
  }, [])

  const can = useCallback((p: Permission) => me?.permissions.includes(p) ?? false, [me])

  const value = useMemo(
    () => ({ status, me, notice, login, register, logout, can }),
    [status, me, notice, login, register, logout, can],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider')
  return ctx
}