import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import type { IntegrationStatus } from '../lib/types'

const PUBLIC_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ''   // clave PUBLICABLE (nunca la secreta)

interface Incident {
  id: number; title: string; description: string; severity: string
  photos: { mediaId: number; url: string; width: number; height: number }[]
  createdBy: { displayName: string }; createdAt: string
}
interface Ticket { ticketId: string; objectPath?: string; bucket?: string }
interface Photo { key: string; name: string; status: 'procesando' | 'subiendo' | 'lista' | 'error' | 'cancelada'; progress: number; mediaId?: number; error?: string; file: File }

// Prepara la foto: lado mayor entre 800 y 1600, WebP sin metadatos (canvas los elimina), máx 300 KB
async function prepare(file: File) {
  const bmp = await createImageBitmap(file)
  const long = Math.max(bmp.width, bmp.height)
  const scale = Math.min(1600, Math.max(800, long)) / long
  const w = Math.round(bmp.width * scale)
  const h = Math.round(bmp.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('El navegador no puede procesar la imagen')
  ctx.drawImage(bmp, 0, 0, w, h)
  for (let q = 0.85; q >= 0.25; q -= 0.1) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', q))
    if (blob && blob.type === 'image/webp' && blob.size <= 307_200) return { blob, w, h }
  }
  throw new Error('No se pudo dejar la imagen en 300 KB')
}

async function sha256(blob: Blob) {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export default function IncidentsPage() {
  const { can } = useAuth()
  const [list, setList] = useState<Incident[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState('LOW')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const xhrs = useRef(new Map<string, XMLHttpRequest>())
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    api<{ content: Incident[] }>('/incidents?page=0&size=10', { signal: ctrl.signal })
      .then((d) => setList(d.content))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setListError(errorMessage(e))
      })
    return () => ctrl.abort()
  }, [reload])

  const patch = (key: string, p: Partial<Photo>) => setPhotos((all) => all.map((x) => (x.key === key ? { ...x, ...p } : x)))

  // ticket -> subida directa a Supabase (con progreso y cancelable) -> confirmar
  async function upload(photo: Photo) {
    patch(photo.key, { status: 'procesando', progress: 0, error: undefined })
    try {
      const status = await api<IntegrationStatus & { storage: { config: { projectUrl?: string } | null } }>('/integrations/status')
      const projectUrl = status.storage.config?.projectUrl
      if (!projectUrl || !PUBLIC_KEY) throw new Error('Storage no configurado en la app')
      const { blob, w, h } = await prepare(photo.file)
      const t = await api<Ticket>('/media/tickets', {
        method: 'POST',
        body: { purpose: 'INCIDENT', contentType: 'image/webp', bytes: blob.size, sha256: await sha256(blob), width: w, height: h },
      })
      const bucket = t.bucket ?? 'lumon-media'
      const path = t.objectPath ?? ''
      patch(photo.key, { status: 'subiendo' })
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhrs.current.set(photo.key, xhr)
        xhr.open('POST', `${projectUrl}/storage/v1/object/${bucket}/${path}`)
        xhr.setRequestHeader('apikey', PUBLIC_KEY)
        xhr.setRequestHeader('Authorization', `Bearer ${PUBLIC_KEY}`)
        xhr.setRequestHeader('Content-Type', 'image/webp')
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) patch(photo.key, { progress: Math.round((ev.loaded / ev.total) * 100) })
        }
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`La subida falló (HTTP ${xhr.status})`)))
        xhr.onerror = () => reject(new Error('Error de red al subir'))
        xhr.onabort = () => reject(new Error('cancelada'))
        xhr.send(blob)
      })
      const media = await api<{ mediaId: number }>(`/media/tickets/${t.ticketId}/confirm`, {
        method: 'POST',
        body: { url: `${projectUrl}/storage/v1/object/public/${bucket}/${path}` },
      })
      patch(photo.key, { status: 'lista', progress: 100, mediaId: media.mediaId })
    } catch (e) {
      const text = errorMessage(e)
      patch(photo.key, text === 'cancelada' ? { status: 'cancelada' } : { status: 'error', error: text })
    } finally {
      xhrs.current.delete(photo.key)
    }
  }

  function addFiles(files: FileList | null) {
    if (!files) return
    const room = 3 - photos.length
    const added = Array.from(files).slice(0, room).map((file) => ({ key: crypto.randomUUID(), name: file.name, status: 'procesando' as const, progress: 0, file }))
    setPhotos((p) => [...p, ...added])
    added.forEach((p) => void upload(p))
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const mediaIds = photos.filter((p) => p.status === 'lista').map((p) => p.mediaId).filter((x): x is number => typeof x === 'number')
    if (mediaIds.length < 1) {
      setMsg('Agrega entre 1 y 3 fotos listas.')
      return
    }
    setSending(true)
    setMsg(null)
    try {
      await api('/incidents', { method: 'POST', body: { title, description, severity, mediaIds } })
      setTitle('')
      setDescription('')
      setPhotos([])
      setMsg('Reporte creado.')
      setReload((n) => n + 1)
    } catch (err) {
      setMsg(`${errorMessage(err)} Puedes reintentar: las fotos siguen listas.`)
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-4">Reportes de incidencia</h1>

      {can('incidents:create') && (
        <form onSubmit={(e) => void onSubmit(e)} className="border rounded p-4 mb-6 space-y-3">
          <label className="block">Título
            <input required minLength={3} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className="w-full border rounded px-2 py-1" />
          </label>
          <label className="block">Descripción
            <textarea required maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full border rounded px-2 py-1" rows={3} />
          </label>
          <label className="block">Severidad
            <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="border rounded px-2 py-1 ml-2">
              <option value="LOW">Baja</option><option value="MEDIUM">Media</option><option value="HIGH">Alta</option><option value="CRITICAL">Crítica</option>
            </select>
          </label>
          {can('media:upload') && photos.length < 3 && (
            <label className="block">Fotos (1 a 3)
              <input type="file" accept="image/*" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} className="block mt-1" />
            </label>
          )}
          <ul className="space-y-2">
            {photos.map((p) => (
              <li key={p.key} className="text-sm border rounded p-2">
                <span className="font-medium">{p.name}</span> — {p.status}{p.error ? `: ${p.error}` : ''}
                <progress max={100} value={p.progress} className="block w-full" aria-label={`Progreso de ${p.name}`} />
                <div className="flex gap-2 mt-1">
                  {p.status === 'subiendo' && <button type="button" className="px-2 border rounded" onClick={() => xhrs.current.get(p.key)?.abort()}>Cancelar</button>}
                  {(p.status === 'error' || p.status === 'cancelada') && <button type="button" className="px-2 border rounded" onClick={() => void upload(p)}>Reintentar</button>}
                  {p.status !== 'subiendo' && p.status !== 'procesando' && <button type="button" className="px-2 border rounded" onClick={() => setPhotos((all) => all.filter((x) => x.key !== p.key))}>Quitar</button>}
                </div>
              </li>
            ))}
          </ul>
          {msg && <p role="status">{msg}</p>}
          <button type="submit" disabled={sending} className="px-4 py-2 rounded bg-teal-700 text-white disabled:opacity-60">{sending ? 'Enviando…' : 'Crear reporte'}</button>
        </form>
      )}

      {listError && <p role="alert" className="text-red-700">{listError}</p>}
      <ul className="space-y-3">
        {list.map((i) => (
          <li key={i.id} className="border rounded p-3">
            {/* Texto externo: SIEMPRE como texto plano */}
            <p className="font-semibold">{i.title} <span className="text-xs">({i.severity})</span></p>
            <p className="whitespace-pre-wrap text-sm">{i.description}</p>
            <p className="text-xs">Por {i.createdBy.displayName}</p>
            <div className="flex gap-2 mt-2">
              {i.photos.map((ph) => <img key={ph.mediaId} src={ph.url} alt={`Foto del reporte ${i.title}`} width={120} height={Math.round((120 * ph.height) / ph.width)} />)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
