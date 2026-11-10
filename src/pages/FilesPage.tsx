import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { onLumonEvent } from '../lib/events'
import type { FilePage } from '../lib/types'

const SIZES = [10, 25, 50]
const STATUSES = ['ACTIVE', 'COMPLETE']
const SORTS = ['updatedAt,desc', 'progress,desc', 'name,asc']

// Lee la URL y la "sanea": un valor inválido se reemplaza por el default (la vista no se rompe)
function readParams(sp: URLSearchParams) {
  const pageN = Number(sp.get('page') ?? '0')
  const sizeN = Number(sp.get('size') ?? '10')
  const status = sp.get('status') ?? ''
  const sort = sp.get('sort') ?? ''
  return {
    page: Number.isInteger(pageN) && pageN >= 0 ? pageN : 0,
    size: SIZES.includes(sizeN) ? sizeN : 10,
    status: STATUSES.includes(status) ? status : '',
    q: (sp.get('q') ?? '').slice(0, 60),
    sort: SORTS.includes(sort) ? sort : 'updatedAt,desc',
  }
}

export default function FilesPage() {
  const [sp, setSp] = useSearchParams()
  const params = readParams(sp)
  const { page, size, status, q, sort } = params
  const [qInput, setQInput] = useState(q)
  const [data, setData] = useState<FilePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)

  // Tiempo real: el progreso cambia sin recargar
  useEffect(
    () =>
      onLumonEvent((e) => {
        if (e.type === 'refinement.created' || e.type === 'file.completed' || e.type === 'stream.reset') {
          setReload((n) => n + 1)
        }
      }),
    [],
  )

  // Si la URL cambia (atrás/adelante), el input refleja la URL
  useEffect(() => {
    setQInput(q)
  }, [q])

  // Cambia parámetros en la URL (todo el estado vive ahí)
  function update(changes: Record<string, string>, replace = false) {
    setSp(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(changes)) {
          if (v === '') next.delete(k)
          else next.set(k, v)
        }
        return next
      },
      { replace },
    )
  }

  // Búsqueda sin una request por tecla: espera 400 ms después de la última tecla
  useEffect(() => {
    if (qInput === q) return
    const t = window.setTimeout(() => update({ q: qInput.trim().slice(0, 60), page: '' }, true), 400)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput])

  // Pedir la página. AbortController: una respuesta vieja nunca pisa a una nueva.
  useEffect(() => {
    const ctrl = new AbortController()
    const qs = new URLSearchParams({ page: String(page), size: String(size), sort })
    if (status) qs.set('status', status)
    if (q) qs.set('q', q)
    setLoading(true)
    setError(null)
    api<FilePage>(`/files?${qs.toString()}`, { signal: ctrl.signal })
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d)
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(errorMessage(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [page, size, status, q, sort, reload])

  return (
    <section>
      <h1 className="text-2xl font-bold mb-4">Archivos de datos</h1>

      <div className="flex flex-wrap gap-3 mb-4 items-end">
        <label className="flex flex-col text-sm">
          Buscar
          <input type="search" value={qInput} maxLength={60} onChange={(e) => setQInput(e.target.value)}
            className="border rounded px-2 py-1" />
        </label>
        <label className="flex flex-col text-sm">
          Estado
          <select value={status} onChange={(e) => update({ status: e.target.value, page: '' })} className="border rounded px-2 py-1">
            <option value="">Todos</option>
            <option value="ACTIVE">Activos</option>
            <option value="COMPLETE">Completados</option>
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Orden
          <select value={sort} onChange={(e) => update({ sort: e.target.value, page: '' })} className="border rounded px-2 py-1">
            <option value="updatedAt,desc">Más recientes</option>
            <option value="progress,desc">Más avanzados</option>
            <option value="name,asc">Nombre A-Z</option>
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Por página
          <select value={size} onChange={(e) => update({ size: e.target.value, page: '' })} className="border rounded px-2 py-1">
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {loading && <span role="status" className="text-sm">Cargando…</span>}
      </div>

      {error && <p role="alert" className="text-red-700 mb-3">{error}</p>}

      {data && data.content.length === 0 && <p>No hay archivos con esos filtros.</p>}

      {data && data.content.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">Archivo</th>
                <th className="p-2">Estado</th>
                <th className="p-2">Progreso</th>
                <th className="p-2">Grupos</th>
                <th className="p-2">Errores</th>
                <th className="p-2">Tamaño</th>
                <th className="p-2"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {data.content.map((f) => (
                <tr key={f.id} className="border-b">
                  <td className="p-2">{f.name}</td>
                  <td className="p-2">{f.status === 'COMPLETE' ? 'Completado' : 'Activo'}</td>
                  <td className="p-2">
                    <progress max={1} value={f.progress.overall} aria-label={`Progreso de ${f.name}`} />{' '}
                    {Math.round(f.progress.overall * 100)}%
                  </td>
                  <td className="p-2">{f.refinedGroups} / {f.totalGroups}</td>
                  <td className="p-2">{f.mistakes}</td>
                  <td className="p-2">{f.rows} × {f.cols}</td>
                  <td className="p-2"><Link to={`/files/${f.id}/refine`} className="underline">Refinar</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <nav aria-label="Paginación" className="flex items-center gap-3 mt-4">
          <button type="button" disabled={page <= 0} onClick={() => update({ page: String(page - 1) })}
            className="px-3 py-1 border rounded disabled:opacity-40">Anterior</button>
          <span>Página {data.totalPages === 0 ? 0 : page + 1} de {data.totalPages} ({data.totalElements} archivos)</span>
          <button type="button" disabled={page + 1 >= data.totalPages} onClick={() => update({ page: String(page + 1) })}
            className="px-3 py-1 border rounded disabled:opacity-40">Siguiente</button>
        </nav>
      )}
    </section>
  )
}
