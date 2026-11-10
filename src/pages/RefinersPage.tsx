import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { onLumonEvent } from '../lib/events'
import type { Refiner, RefinerPage } from '../lib/types'

// Directorio del personal: paginado en el servidor, estado en la URL, textos externos como TEXTO
export default function RefinersPage() {
  const [sp, setSp] = useSearchParams()
  const pageN = Number(sp.get('page') ?? '0')
  const page = Number.isInteger(pageN) && pageN >= 0 ? pageN : 0
  const q = (sp.get('q') ?? '').slice(0, 60)
  const [qInput, setQInput] = useState(q)
  const [data, setData] = useState<RefinerPage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setQInput(q), [q])

  useEffect(() => {
    if (qInput === q) return
    const t = window.setTimeout(() => {
      const next = new URLSearchParams(sp)
      if (qInput.trim()) next.set('q', qInput.trim().slice(0, 60))
      else next.delete('q')
      next.delete('page')
      setSp(next, { replace: true })
    }, 400)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput])

  useEffect(() => {
    const ctrl = new AbortController()
    const qs = new URLSearchParams({ page: String(page), size: '10' })
    if (q) qs.set('q', q)
    setError(null)
    api<RefinerPage>(`/refiners?${qs.toString()}`, { signal: ctrl.signal })
      .then((d) => setData(d))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(errorMessage(e))
      })
    return () => ctrl.abort()
  }, [page, q])

  // Tiempo real: un expediente más nuevo reemplaza al de la lista (nunca uno más viejo)
  useEffect(
    () =>
      onLumonEvent((e) => {
        if (e.type !== 'refiner.updated') return
        const r = (e.data as { refiner: Refiner }).refiner
        setData((d) =>
          d ? { ...d, content: d.content.map((x) => (x.id === r.id && r.version > x.version ? { ...x, ...r } : x)) } : d,
        )
      }),
    [],
  )

  function go(p: number) {
    const next = new URLSearchParams(sp)
    next.set('page', String(p))
    setSp(next)
  }

  return (
    <section>
      <h1 className="text-2xl font-bold mb-4">Directorio del personal</h1>
      <label className="flex flex-col text-sm mb-4 max-w-xs">
        Buscar
        <input type="search" value={qInput} maxLength={60} onChange={(e) => setQInput(e.target.value)} className="border rounded px-2 py-1" />
      </label>
      {error && <p role="alert" className="text-red-700 mb-3">{error}</p>}
      {data && data.content.length === 0 && <p>No hay expedientes.</p>}
      {data && data.content.length > 0 && (
        <ul className="divide-y border rounded">
          {data.content.map((r) => (
            <li key={r.id} className="p-3">
              <Link to={`/refiners/${r.id}`} className="font-semibold underline">{r.fullName}</Link>
              <p className="text-sm">{r.title} · {r.department.name} · anexo {r.extension}</p>
            </li>
          ))}
        </ul>
      )}
      {data && (
        <nav aria-label="Paginación" className="flex items-center gap-3 mt-4">
          <button type="button" disabled={page <= 0} onClick={() => go(page - 1)} className="px-3 py-1 border rounded disabled:opacity-40">Anterior</button>
          <span>Página {data.totalPages === 0 ? 0 : page + 1} de {data.totalPages}</span>
          <button type="button" disabled={page + 1 >= data.totalPages} onClick={() => go(page + 1)} className="px-3 py-1 border rounded disabled:opacity-40">Siguiente</button>
        </nav>
      )}
    </section>
  )
}
