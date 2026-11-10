import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { apiRaw } from '../lib/api'
import { ApiError, errorMessage, fieldErrors } from '../lib/errors'
import { onLumonEvent } from '../lib/events'
import type { Refiner } from '../lib/types'

interface Draft { title: string; extension: string; bio: string }

const isHttp = (u: string | null): u is string => !!u && /^https?:\/\//i.test(u)

// Expediente: textos externos SIEMPRE como texto (React escapa; nunca dangerouslySetInnerHTML).
// Edición con If-Match = ETag exacto. 412 -> pantalla de conflicto, nunca se pisa lo no leído.
export default function RefinerPage() {
  const { id } = useParams()
  const { can } = useAuth()
  const [refiner, setRefiner] = useState<Refiner | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft>({ title: '', extension: '', bio: '' })
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<{ current: Refiner; etag: string | null } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    apiRaw<Refiner>(`/refiners/${id ?? ''}`, { signal: ctrl.signal })
      .then(({ data, headers }) => {
        setRefiner(data)
        setEtag(headers.get('ETag'))
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof ApiError && e.status === 404 ? 'Ese expediente no existe.' : errorMessage(e))
      })
    return () => ctrl.abort()
  }, [id])

  // refiner.updated: una versión más vieja nunca pisa a una más nueva
  useEffect(
    () =>
      onLumonEvent((e) => {
        if (e.type !== 'refiner.updated') return
        const d = e.data as { refiner: Refiner; updatedBy: { displayName: string } }
        setRefiner((cur) => {
          if (!cur || cur.id !== d.refiner.id || d.refiner.version <= cur.version) return cur
          setEtag(`"${d.refiner.version}"`)
          setNotice(`${d.updatedBy.displayName} actualizó este expediente.`)
          return { ...cur, ...d.refiner }
        })
      }),
    [],
  )

  if (error) return <section><p role="alert" className="mb-3">{error}</p><Link to="/refiners" className="underline">Volver</Link></section>
  if (!refiner) return <p role="status">Cargando expediente…</p>

  function startEdit(base: Refiner) {
    setDraft({ title: base.title, extension: base.extension, bio: base.bio })
    setFields({})
    setEditing(true)
  }

  async function save(e: FormEvent<HTMLFormElement>, useEtag = etag) {
    e.preventDefault()
    if (!useEtag) return
    setSaving(true)
    setFields({})
    try {
      const { data, headers } = await apiRaw<Refiner>(`/refiners/${refiner?.id ?? ''}`, {
        method: 'PATCH',
        body: draft,
        headers: { 'If-Match': useEtag },
      })
      setRefiner(data)
      setEtag(headers.get('ETag'))
      setEditing(false)
      setConflict(null)
      setNotice('Cambios guardados.')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        const current = (err.details as { current: Refiner }).current
        setConflict({ current, etag: `"${current.version}"` })
      } else {
        setFields(fieldErrors(err))
        setNotice(errorMessage(err))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="max-w-2xl">
      <Link to="/refiners" className="underline text-sm">Volver al directorio</Link>
      <h1 className="text-2xl font-bold mt-2">{refiner.fullName}</h1>
      <p>{refiner.title} · {refiner.department.name} · anexo {refiner.extension}</p>
      {refiner.badge && <img src={refiner.badge.url} width={refiner.badge.width} height={refiner.badge.height} alt={`Fotocheck de ${refiner.fullName}`} className="my-3 max-w-40 h-auto" />}
      <p className="whitespace-pre-wrap my-3">{refiner.bio}</p>
      {isHttp(refiner.profileUrl)
        ? <a href={refiner.profileUrl} target="_blank" rel="noopener noreferrer" className="underline">Perfil externo</a>
        : refiner.profileUrl && <p className="text-sm">Perfil: {refiner.profileUrl}</p>}
      <p className="text-xs mt-2">Versión {refiner.version}</p>
      {notice && <p role="status" className="mt-2 p-2 bg-amber-100 rounded">{notice}</p>}

      {conflict && (
        <div role="alertdialog" aria-labelledby="conflict-title" className="border-2 border-red-600 rounded p-4 mt-4">
          <h2 id="conflict-title" className="font-bold text-lg mb-2">Conflicto: alguien cambió este expediente</h2>
          <p className="mb-2">Versión actual ({conflict.current.version}): título “{conflict.current.title}”, anexo {conflict.current.extension}.</p>
          <p className="mb-3">Tus cambios: título “{draft.title}”, anexo {draft.extension}.</p>
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="px-3 py-1 border rounded" onClick={() => {
              setRefiner(conflict.current); setEtag(conflict.etag); setConflict(null); startEdit(conflict.current)
            }}>Descartar mis cambios y usar la versión actual</button>
            <button type="button" className="px-3 py-1 rounded bg-teal-700 text-white" onClick={(ev) => {
              setRefiner(conflict.current); setEtag(conflict.etag)
              void save(ev as unknown as FormEvent<HTMLFormElement>, conflict.etag)
            }}>Guardar mis cambios sobre la versión actual</button>
          </div>
        </div>
      )}

      {can('refiners:write') && !editing && (
        <button type="button" onClick={() => startEdit(refiner)} className="mt-4 px-3 py-1 border rounded">Editar</button>
      )}
      {editing && (
        <form onSubmit={(e) => void save(e)} className="mt-4 space-y-3">
          <label className="block">Título
            <input value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="w-full border rounded px-2 py-1" />
            {fields.title && <span className="text-red-700 text-sm">{fields.title}</span>}
          </label>
          <label className="block">Anexo (3 a 6 dígitos)
            <input value={draft.extension} onChange={(e) => setDraft({ ...draft, extension: e.target.value })} className="w-full border rounded px-2 py-1" />
            {fields.extension && <span className="text-red-700 text-sm">{fields.extension}</span>}
          </label>
          <label className="block">Bio
            <textarea value={draft.bio} maxLength={2000} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} className="w-full border rounded px-2 py-1" rows={4} />
            {fields.bio && <span className="text-red-700 text-sm">{fields.bio}</span>}
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="px-3 py-1 rounded bg-teal-700 text-white disabled:opacity-60">{saving ? 'Guardando…' : 'Guardar'}</button>
            <button type="button" onClick={() => setEditing(false)} className="px-3 py-1 border rounded">Cancelar</button>
          </div>
        </form>
      )}
    </section>
  )
}
