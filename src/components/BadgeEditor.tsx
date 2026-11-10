import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { api, apiRaw } from '../lib/api'
import { ApiError, errorMessage } from '../lib/errors'
import type { IntegrationStatus, Refiner } from '../lib/types'

const PUBLIC_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ''   // clave PUBLICABLE
const VIEW = 256        // lado del recuadro de recorte en pantalla
const OUT = 512         // fotocheck: exactamente 512 x 512
const MAX_BYTES = 122_880

interface Props {
  refinerId: number
  etag: string | null
  onSaved: (r: Refiner, etag: string | null) => void
  onCancel: () => void
}

async function sha256(blob: Blob) {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Editor del fotocheck: recorte cuadrado (arrastrar / flechas, zoom), WebP 512x512 sin metadatos,
// subida con progreso (cancelar / reintentar) y PATCH con If-Match.
export default function BadgeEditor({ refinerId, etag, onSaved, onCancel }: Props) {
  const [img, setImg] = useState<{ url: string; bmp: ImageBitmap } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [dx, setDx] = useState(0)
  const [dy, setDy] = useState(0)
  const [phase, setPhase] = useState<'editar' | 'procesando' | 'subiendo' | 'guardando' | 'error' | 'cancelado' | 'conflicto'>('editar')
  const [progress, setProgress] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  const [mediaId, setMediaId] = useState<number | null>(null)
  const [conflictEtag, setConflictEtag] = useState<string | null>(null)
  const xhr = useRef<XMLHttpRequest | null>(null)

  useEffect(() => () => { if (img) URL.revokeObjectURL(img.url) }, [img])

  // Geometría del recorte ("cover": la imagen siempre cubre el cuadrado)
  const w = img?.bmp.width ?? 1
  const h = img?.bmp.height ?? 1
  const scale = (VIEW / Math.min(w, h)) * zoom
  const maxX = (w * scale - VIEW) / 2
  const maxY = (h * scale - VIEW) / 2
  const cx = Math.max(-maxX, Math.min(maxX, dx))
  const cy = Math.max(-maxY, Math.min(maxY, dy))
  const left = (VIEW - w * scale) / 2 + cx
  const top = (VIEW - h * scale) / 2 + cy

  async function pick(file: File | undefined) {
    if (!file) return
    try {
      const bmp = await createImageBitmap(file)
      setImg({ url: URL.createObjectURL(file), bmp })
      setZoom(1); setDx(0); setDy(0); setPhase('editar'); setMsg(null); setMediaId(null)
    } catch {
      setMsg('No se pudo leer esa imagen.')
    }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const sx = e.clientX, sy = e.clientY, ox = cx, oy = cy
    e.currentTarget.setPointerCapture(e.pointerId)
    const target = e.currentTarget
    const move = (ev: PointerEvent) => { setDx(ox + ev.clientX - sx); setDy(oy + ev.clientY - sy) }
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up) }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = 8
    if (e.key === 'ArrowLeft') setDx(cx - step)
    else if (e.key === 'ArrowRight') setDx(cx + step)
    else if (e.key === 'ArrowUp') setDy(cy - step)
    else if (e.key === 'ArrowDown') setDy(cy + step)
    else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(3, z + 0.1))
    else if (e.key === '-') setZoom((z) => Math.max(1, z - 0.1))
    else return
    e.preventDefault()
  }

  async function patchBadge(id: number, useEtag: string | null) {
    if (!useEtag) throw new Error('Falta el ETag del expediente')
    setPhase('guardando')
    try {
      const { data, headers } = await apiRaw<Refiner>(`/refiners/${refinerId}`, {
        method: 'PATCH', body: { badgeMediaId: id }, headers: { 'If-Match': useEtag },
      })
      onSaved(data, headers.get('ETag'))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        const current = (e.details as { current: Refiner }).current
        setConflictEtag(`"${current.version}"`)
        setPhase('conflicto')
        setMsg(`Alguien cambió el expediente (ahora versión ${current.version}). Tu foto ya está subida: confirma para guardarla sobre la versión actual.`)
        return
      }
      throw e
    }
  }

  async function uploadAndSave() {
    if (!img) return
    setMsg(null)
    try {
      if (mediaId) { await patchBadge(mediaId, etag); return }   // reintento: la foto ya estaba confirmada
      setPhase('procesando')
      // 1. Recorte -> 512x512 WebP (el canvas no copia metadatos)
      const canvas = document.createElement('canvas')
      canvas.width = OUT
      canvas.height = OUT
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('El navegador no puede procesar la imagen')
      ctx.drawImage(img.bmp, -left / scale, -top / scale, VIEW / scale, VIEW / scale, 0, 0, OUT, OUT)
      let blob: Blob | null = null
      for (let q = 0.9; q >= 0.2; q -= 0.1) {
        const b = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', q))
        if (b && b.type === 'image/webp' && b.size <= MAX_BYTES) { blob = b; break }
      }
      if (!blob) throw new Error('No se pudo dejar la foto en 120 KB')
      // 2. Ticket
      const status = await api<IntegrationStatus & { storage: { config: { projectUrl?: string } | null } }>('/integrations/status')
      const projectUrl = status.storage.config?.projectUrl
      if (!projectUrl || !PUBLIC_KEY) throw new Error('Storage no configurado en la app')
      const t = await api<{ ticketId: string; objectPath?: string; bucket?: string }>('/media/tickets', {
        method: 'POST',
        body: { purpose: 'BADGE', contentType: 'image/webp', bytes: blob.size, sha256: await sha256(blob), width: OUT, height: OUT },
      })
      const bucket = t.bucket ?? 'lumon-media'
      const path = t.objectPath ?? ''
      // 3. Subida directa al storage, con progreso y cancelable
      setPhase('subiendo')
      setProgress(0)
      const body = blob
      await new Promise<void>((resolve, reject) => {
        const x = new XMLHttpRequest()
        xhr.current = x
        x.open('POST', `${projectUrl}/storage/v1/object/${bucket}/${path}`)
        x.setRequestHeader('apikey', PUBLIC_KEY)
        x.setRequestHeader('Authorization', `Bearer ${PUBLIC_KEY}`)
        x.setRequestHeader('Content-Type', 'image/webp')
        x.upload.onprogress = (ev) => { if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100)) }
        x.onload = () => (x.status < 300 ? resolve() : reject(new Error(`La subida falló (HTTP ${x.status})`)))
        x.onerror = () => reject(new Error('Error de red al subir'))
        x.onabort = () => reject(new Error('cancelada'))
        x.send(body)
      })
      // 4. Confirmar y 5. guardar en el expediente con If-Match
      const media = await api<{ mediaId: number }>(`/media/tickets/${t.ticketId}/confirm`, {
        method: 'POST', body: { url: `${projectUrl}/storage/v1/object/public/${bucket}/${path}` },
      })
      setMediaId(media.mediaId)
      await patchBadge(media.mediaId, etag)
    } catch (e) {
      const text = errorMessage(e)
      if (text === 'cancelada') { setPhase('cancelado'); setMsg('Subida cancelada. Puedes reintentar.') }
      else { setPhase('error'); setMsg(`${text} Puedes reintentar.`) }
    } finally {
      xhr.current = null
    }
  }

  const busy = phase === 'procesando' || phase === 'subiendo' || phase === 'guardando'

  return (
    <div className="border rounded p-4 mt-4 space-y-3" aria-label="Editor del fotocheck">
      <h2 className="font-bold">Fotocheck (512 × 512)</h2>
      <label className="block text-sm">Elegir foto
        <input type="file" accept="image/*" disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} className="block mt-1" />
      </label>
      {img && (
        <>
          <div
            tabIndex={0}
            role="img"
            aria-label="Recorte del fotocheck. Arrastra o usa las flechas para mover, + y - para el zoom."
            onPointerDown={onPointerDown}
            onKeyDown={onKey}
            className="relative overflow-hidden border-2 border-black cursor-move touch-none select-none"
            style={{ width: VIEW, height: VIEW }}
          >
            <img src={img.url} alt="" draggable={false} className="absolute max-w-none pointer-events-none"
              style={{ left, top, width: w * scale, height: h * scale }} />
          </div>
          <label className="block text-sm">Zoom
            <input type="range" min={1} max={3} step={0.05} value={zoom} disabled={busy}
              onChange={(e) => setZoom(Number(e.target.value))} className="block w-64" />
          </label>
        </>
      )}
      {phase === 'subiendo' && (
        <div>
          <progress max={100} value={progress} className="w-64 block" aria-label="Progreso de la subida" />
          <button type="button" className="px-2 border rounded mt-1" onClick={() => xhr.current?.abort()}>Cancelar subida</button>
        </div>
      )}
      {busy && <p role="status" className="text-sm">{phase}…</p>}
      {msg && <p role="alert" className="text-sm">{msg}</p>}
      <div className="flex gap-2">
        {phase === 'conflicto' ? (
          <button type="button" className="px-3 py-1 rounded bg-teal-700 text-white"
            onClick={() => { if (mediaId) void patchBadge(mediaId, conflictEtag).catch((e: unknown) => { setPhase('error'); setMsg(errorMessage(e)) }) }}>
            Guardar el fotocheck sobre la versión actual
          </button>
        ) : (
          <button type="button" disabled={!img || busy} onClick={() => void uploadAndSave()}
            className="px-3 py-1 rounded bg-teal-700 text-white disabled:opacity-50">
            {phase === 'error' || phase === 'cancelado' ? 'Reintentar' : 'Recortar y guardar'}
          </button>
        )}
        <button type="button" disabled={busy} onClick={onCancel} className="px-3 py-1 border rounded">Cerrar</button>
      </div>
    </div>
  )
}
