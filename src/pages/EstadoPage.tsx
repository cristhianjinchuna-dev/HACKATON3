import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { API_URL, BUILD } from '../lib/config'
import { errorMessage } from '../lib/errors'
import type { ClearanceCheckResult, IntegrationStatus } from '../lib/types'

// /estado: build desplegado, API, integraciones y botón "Abrir el Piso de Pruebas"
export default function EstadoPage() {
  const { me } = useAuth()
  const [health, setHealth] = useState('verificando…')
  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [result, setResult] = useState<ClearanceCheckResult | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    api('/meta/health', { auth: false, signal: ctrl.signal })
      .then(() => setHealth('responde'))
      .catch(() => {
        if (!ctrl.signal.aborted) setHealth('no responde')
      })
    api<IntegrationStatus>('/integrations/status', { signal: ctrl.signal })
      .then(setStatus)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setStatusError(errorMessage(e))
      })
    return () => ctrl.abort()
  }, [])

  async function runCheck() {
    setChecking(true)
    setCheckError(null)
    try {
      setResult(await api<ClearanceCheckResult>('/clearance/check', { method: 'POST' }))
    } catch (e) {
      setCheckError(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">Estado</h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mb-6">
        <dt className="font-semibold">Build</dt><dd><code>{BUILD}</code></dd>
        <dt className="font-semibold">API</dt><dd>{API_URL} ({health})</dd>
        <dt className="font-semibold">Dominio</dt><dd>{status?.deploy.origin ?? '—'} {status?.deploy.verifiedAt ? '(verificado)' : ''}</dd>
        <dt className="font-semibold">Último build visto</dt><dd>{status?.deploy.lastBuildSeen ?? '—'}</dd>
        <dt className="font-semibold">Storage</dt><dd>{status?.storage.provider ?? '—'} {status?.storage.verifiedAt ? '(verificado)' : '(no verificado)'}</dd>
        <dt className="font-semibold">Piso de Pruebas</dt><dd>{me?.clearance.granted ? 'Abierto' : 'Cerrado'}</dd>
      </dl>
      {statusError && <p role="alert" className="text-red-700 mb-4">Integraciones: {statusError}</p>}

      <button type="button" onClick={() => void runCheck()} disabled={checking}
        className="px-4 py-2 rounded bg-teal-700 text-white disabled:opacity-50">
        {checking ? 'Revisando…' : 'Abrir el Piso de Pruebas'}
      </button>
      {checkError && <p role="alert" className="text-red-700 mt-3">{checkError}</p>}
      {result && (
        <div className="mt-4" aria-live="polite">
          <p className="font-semibold mb-2">{result.granted ? 'Piso abierto ✅' : 'Aún falta algo'}</p>
          <ul className="space-y-1">
            {result.checks.map((c) => (
              <li key={c.name}>{c.passed ? '✅' : '❌'} <strong>{c.name}</strong>: {c.detail}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}