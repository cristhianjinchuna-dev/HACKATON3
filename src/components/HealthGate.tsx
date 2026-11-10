import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'

// Si /meta/health no responde: "Conectando con Lumon…", reintento automático con espera creciente + botón manual
export default function HealthGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [waitSec, setWaitSec] = useState<number | null>(null)

  useEffect(() => {
    if (ok) return
    let cancelled = false
    let retry: number | undefined
    const ctrl = new AbortController()
    const timeout = window.setTimeout(() => ctrl.abort(), 8000)

    api('/meta/health', { auth: false, signal: ctrl.signal, maxRetries: 0 })
      .then(() => {
        if (!cancelled) setOk(true)
      })
      .catch(() => {
        if (cancelled) return
        const secs = Math.min(2 ** attempt, 30)   // 1, 2, 4, 8, 16, 30…
        setWaitSec(secs)
        retry = window.setTimeout(() => setAttempt((a) => a + 1), secs * 1000)
      })
      .finally(() => window.clearTimeout(timeout))

    return () => {
      cancelled = true
      ctrl.abort()
      window.clearTimeout(timeout)
      window.clearTimeout(retry)
    }
  }, [attempt, ok])

  if (ok) return <>{children}</>

  return (
    <div className="min-h-screen grid place-items-center p-6">
      <div className="text-center" role="status" aria-live="polite">
        <h1 className="text-2xl font-bold mb-2">Conectando con Lumon…</h1>
        {waitSec !== null && (
          <p className="mb-4">La API no responde. Reintento automático en {waitSec}s (intento {attempt + 1}).</p>
        )}
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          className="px-4 py-2 rounded bg-teal-700 text-white"
        >
          Reintentar ahora
        </button>
      </div>
    </div>
  )
}