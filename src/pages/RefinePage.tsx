import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { apiRaw, api } from '../lib/api'
import { ApiError, errorMessage } from '../lib/errors'
import { onLumonEvent } from '../lib/events'
import { sleep } from '../lib/sleep'
import { BINS, type Bin, type FileItem, type Progress, type RefineResult, type Rules } from '../lib/types'
import { findGroup, type Cell, type Group } from '../mdr/group'
import { TileStore, tileKey } from '../mdr/tileStore'

const CELL = 28      // px por celda
const OVERSCAN = 2   // filas/columnas extra alrededor de lo visible
const MAX_CELLS = 2400

const LETTER: Record<Bin, string> = { WO: 'W', FC: 'F', DR: 'D', MA: 'M' }
const BIN_NAME: Record<Bin, string> = { WO: 'WO', FC: 'FC', DR: 'DR', MA: 'MA' }

const REASONS: Record<string, string> = {
  BELOW_THRESHOLD: 'Alguna celda no da miedo.',
  NOT_CONNECTED: 'Las celdas son de más de un grupo.',
  INCOMPLETE: 'Faltan celdas del grupo.',
  SIZE_OUT_OF_RANGE: 'El grupo es ruido (tamaño fuera de rango).',
}

function clampInt(v: string | null, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isInteger(n)) return min
  return Math.min(Math.max(n, min), max)
}

// ---------------------------------------------------------------------------
// Página: carga el archivo y sus reglas, luego muestra la grilla
// ---------------------------------------------------------------------------
export default function RefinePage() {
  const { id } = useParams()
  const fileId = Number(id)
  const validId = Number.isInteger(fileId) && fileId > 0
  const [file, setFile] = useState<FileItem | null>(null)
  const [rules, setRules] = useState<Rules | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!validId) return
    const ctrl = new AbortController()
    Promise.all([
      api<FileItem>(`/files/${fileId}`, { signal: ctrl.signal }),
      api<Rules>(`/files/${fileId}/rules`, { signal: ctrl.signal }),   // las reglas cambian por archivo
    ])
      .then(([f, r]) => {
        setFile(f)
        setRules(r)
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) {
          setError(e instanceof ApiError && e.status === 404 ? 'Ese archivo no existe.' : errorMessage(e))
        }
      })
    return () => ctrl.abort()
  }, [fileId, validId])

  if (!validId || error) {
    return (
      <section>
        <p role="alert" className="mb-3">{validId ? error : 'Id de archivo inválido.'}</p>
        <Link to="/files" className="underline">Volver a los archivos</Link>
      </section>
    )
  }
  if (!file || !rules) return <p role="status">Cargando archivo…</p>

  return <Board key={file.id} initialFile={file} rules={rules} />
}

// ---------------------------------------------------------------------------
// Grilla virtualizada + selección de grupo + cajas
// ---------------------------------------------------------------------------
function Board({ initialFile, rules }: { initialFile: FileItem; rules: Rules }) {
  const { can } = useAuth()
  const canRefine = can('files:refine')
  const [file, setFile] = useState(initialFile)
  const [sp, setSp] = useSearchParams()

  const store = useMemo(() => new TileStore(initialFile.id, initialFile.tileSize), [initialFile.id, initialFile.tileSize])
  const [, setTick] = useState(0)
  useEffect(() => {
    const off = store.subscribe(() => setTick((t) => t + 1))
    return () => {
      off()
      store.dispose()
    }
  }, [store])

  // Tiempo real: refinamientos de otros, archivo completado y stream.reset (sin recargar)
  useEffect(
    () =>
      onLumonEvent((e) => {
        if (e.type === 'refinement.created') {
          const d = e.data as { fileId: number; cells: Cell[]; bin: Bin; progress: Progress }
          if (d.fileId !== initialFile.id) return
          store.applyBin(d.cells, LETTER[d.bin])
          setFile((f) => ({ ...f, progress: d.progress }))
          setGroup((g) => (g && d.cells.some((x) => g.ids.has(x.r * initialFile.cols + x.c)) ? null : g))
        } else if (e.type === 'file.completed') {
          const d = e.data as { fileId: number }
          if (d.fileId === initialFile.id) setFile((f) => ({ ...f, status: 'COMPLETE' }))
        } else if (e.type === 'stream.reset') {
          api<FileItem>(`/files/${initialFile.id}`).then(setFile).catch(() => {})
        }
      }),
    [store, initialFile.id, initialFile.cols],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, left: 0, width: 800, height: 500 })
  const [focus, setFocus] = useState<Cell>({ r: 0, c: 0 })
  const focusInGrid = useRef(false)
  const urlTimer = useRef(0)

  const [group, setGroup] = useState<Group | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const pending = useRef(false)
  // Intención actual: misma key si se reintenta el MISMO grupo con la MISMA caja
  const intent = useRef<{ key: string; sig: string } | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)

  // Posición inicial desde la URL (?r=&c=)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const r = clampInt(sp.get('r'), 0, file.rows - 1)
    const c = clampInt(sp.get('c'), 0, file.cols - 1)
    el.scrollTop = r * CELL
    el.scrollLeft = c * CELL
    setView({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight })
    setFocus({ r, c })
    // solo al montar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setView((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    setView({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight })
    // La URL guarda la posición, con replace: el scroll no llena el historial
    window.clearTimeout(urlTimer.current)
    urlTimer.current = window.setTimeout(() => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('r', String(Math.floor(el.scrollTop / CELL)))
          next.set('c', String(Math.floor(el.scrollLeft / CELL)))
          return next
        },
        { replace: true },
      )
    }, 250)
  }
  useEffect(() => () => window.clearTimeout(urlTimer.current), [])

  // Rango visible (virtualización)
  const r0 = Math.max(0, Math.floor(view.top / CELL) - OVERSCAN)
  const r1 = Math.min(file.rows - 1, Math.floor((view.top + view.height) / CELL) + OVERSCAN)
  const c0 = Math.max(0, Math.floor(view.left / CELL) - OVERSCAN)
  let c1 = Math.min(file.cols - 1, Math.floor((view.left + view.width) / CELL) + OVERSCAN)
  const nRows = r1 - r0 + 1
  if (nRows * (c1 - c0 + 1) > MAX_CELLS) c1 = c0 + Math.floor(MAX_CELLS / nRows) - 1

  // Bloques necesarios para lo visible: pedirlos y cancelar los que ya no se ven
  const ts = file.tileSize
  const tr0 = Math.floor(r0 / ts)
  const tr1 = Math.floor(r1 / ts)
  const tc0 = Math.floor(c0 / ts)
  const tc1 = Math.floor(c1 / ts)
  useEffect(() => {
    const keep = new Set<string>()
    for (let tr = tr0; tr <= tr1; tr++) {
      for (let tc = tc0; tc <= tc1; tc++) {
        keep.add(tileKey(tr, tc))
        store.load(tr, tc).catch(() => {
          // cancelado o error: se reintenta cuando vuelva a verse
        })
      }
    }
    store.cancelExcept(keep)
  }, [store, tr0, tr1, tc0, tc1])

  // Mantener el foco del DOM en la celda activa (roving tabindex)
  useEffect(() => {
    if (!focusInGrid.current) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${focus.r}:${focus.c}"]`)
    el?.focus({ preventScroll: true })
  }, [focus])

  function moveFocus(r: number, c: number) {
    const nr = Math.min(Math.max(r, 0), file.rows - 1)
    const nc = Math.min(Math.max(c, 0), file.cols - 1)
    const el = scrollRef.current
    if (el) {
      if (nr * CELL < el.scrollTop) el.scrollTop = nr * CELL
      else if ((nr + 1) * CELL > el.scrollTop + el.clientHeight) el.scrollTop = (nr + 1) * CELL - el.clientHeight
      if (nc * CELL < el.scrollLeft) el.scrollLeft = nc * CELL
      else if ((nc + 1) * CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = (nc + 1) * CELL - el.clientWidth
    }
    focusInGrid.current = true
    setFocus({ r: nr, c: nc })
  }

  // ---------------- Selección del grupo completo ----------------
  const selectAt = useCallback(
    async (cell: Cell) => {
      const info = store.cell(cell.r, cell.c)
      if (!info) {
        setMessage('Ese bloque todavía está cargando.')
        return
      }
      if (info.bin !== '.') {
        setGroup(null)
        setMessage('Esa celda ya está refinada.')
        return
      }
      if (info.tremor < rules.tremorThreshold) {
        setGroup(null)
        setMessage('Esa celda no da miedo.')
        return
      }
      setSelecting(true)
      setMessage(null)
      try {
        const g = await findGroup(store, file, rules, cell)
        setGroup(g)
      } catch (e) {
        setMessage(errorMessage(e))
      } finally {
        setSelecting(false)
      }
    },
    [store, file, rules],
  )

  // ---------------- Refinar (idempotente) ----------------
  async function refine(bin: Bin) {
    if (!group || group.noise || pending.current || !canRefine) return   // doble clic / doble Enter: ignorado
    const cells = group.cells
    const sig = `${bin}|${cells.map((x) => `${x.r},${x.c}`).sort().join(';')}`
    if (!intent.current || intent.current.sig !== sig) {
      intent.current = { key: crypto.randomUUID(), sig }   // intención nueva -> key nueva
    }
    const key = intent.current.key
    pending.current = true
    setBusy(true)
    setMessage(null)
    try {
      let result: { data: RefineResult; headers: Headers } | null = null
      for (let attempt = 0; !result; attempt++) {
        try {
          // 503 (caos): apiRaw espera Retry-After y reintenta con la MISMA key
          result = await apiRaw<RefineResult>(`/files/${file.id}/refinements`, {
            method: 'POST',
            body: { bin, cells },
            headers: { 'Idempotency-Key': key },
            maxRetries: 6,
          })
        } catch (e) {
          // Falla de red (sin respuesta): reintentar con la MISMA key
          if (!(e instanceof ApiError) && attempt < 3) {
            await sleep(1000 * 2 ** attempt)
            continue
          }
          throw e
        }
      }
      const res = result.data
      store.applyBin(cells, LETTER[bin])
      setFile((f) => ({ ...f, ...res.file }))
      setGroup(null)
      intent.current = null
      const replayed = result.headers.get('Idempotent-Replayed') === 'true'
      setMessage(`Grupo de ${res.size} celdas refinado en ${BIN_NAME[bin]}.${replayed ? ' (respuesta repetida por reintento)' : ''}`)
    } catch (e) {
      if (e instanceof ApiError) {
        const d = (typeof e.details === 'object' && e.details !== null ? e.details : {}) as {
          reason?: string; missing?: number; mistakes?: number; tiles?: [number, number][]; holder?: { displayName?: string }
        }
        if (e.code === 'ALREADY_REFINED') {
          d.tiles?.forEach(([tr, tc]) => {
            store.load(tr, tc, { force: true, pinned: true }).catch(() => {})
          })
          setGroup(null)
          intent.current = null
          setMessage('Algunas celdas ya estaban refinadas. Actualicé esos bloques; vuelve a elegir un grupo.')
        } else if (e.code === 'GROUP_CLAIMED') {
          setMessage(`Ese grupo lo tiene reservado ${d.holder?.displayName ?? 'otro usuario'}. Intenta en un momento.`)
        } else if (e.code === 'WRONG_BIN') {
          if (typeof d.mistakes === 'number') {
            const mistakes = d.mistakes
            setFile((f) => ({ ...f, mistakes }))
          }
          setMessage(`Caja equivocada. Según las reglas corresponde ${group.bin ?? '—'}. Errores del archivo: ${d.mistakes ?? '?'}.`)
        } else if (e.code === 'GROUP_INVALID') {
          const extra = d.reason === 'INCOMPLETE' && d.missing ? ` Faltan ${d.missing}.` : ''
          setMessage(`Grupo inválido: ${REASONS[d.reason ?? ''] ?? e.message}${extra} Vuelve a seleccionarlo.`)
          setGroup(null)
          intent.current = null
        } else if (e.code === 'FORBIDDEN') {
          setMessage('No tienes permiso para refinar.')
        } else {
          setMessage(`${e.message} Puedes reintentar: no se refinará dos veces.`)
        }
      } else {
        setMessage(`Sin conexión. Reintenta: se usará la misma operación y no se refinará dos veces.`)
      }
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  // ---------------- Arrastrar el grupo a una caja (Pointer Events) ----------------
  function onCellPointerDown(e: ReactPointerEvent<HTMLDivElement>, r: number, c: number) {
    if (!group || group.noise || !group.ids.has(r * file.cols + c) || !canRefine) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
      moved = true
      setDrag({ x: ev.clientX, y: ev.clientY })
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setDrag(null)
      if (!moved) return
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-bin]')
      const bin = target?.dataset.bin
      if (bin === 'WO' || bin === 'FC' || bin === 'DR' || bin === 'MA') void refine(bin)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // ---------------- Teclado ----------------
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const page = Math.max(1, Math.floor(view.height / CELL) - 1)
    const { r, c } = focus
    switch (e.key) {
      case 'ArrowUp': moveFocus(r - 1, c); break
      case 'ArrowDown': moveFocus(r + 1, c); break
      case 'ArrowLeft': moveFocus(r, c - 1); break
      case 'ArrowRight': moveFocus(r, c + 1); break
      case 'PageUp': moveFocus(r - page, c); break
      case 'PageDown': moveFocus(r + page, c); break
      case 'Home': moveFocus(e.ctrlKey ? 0 : r, 0); break
      case 'End': moveFocus(e.ctrlKey ? file.rows - 1 : r, file.cols - 1); break
      case 'Enter':
      case ' ': void selectAt(focus); break
      case 'Escape': setGroup(null); break
      case '1': case '2': case '3': case '4': void refine(BINS[Number(e.key) - 1]); break
      default: return
    }
    e.preventDefault()
  }

  // ---------------- Render ----------------
  if (file.status === 'COMPLETE') {
    return (
      <section className="text-center py-10">
        <h1 className="text-3xl font-bold mb-2">Archivo completado</h1>
        <p className="mb-1">{file.name}: {file.refinedGroups} de {file.totalGroups} grupos refinados.</p>
        <p className="mb-4">Errores: {file.mistakes}</p>
        <Link to="/files" className="underline">Volver a los archivos</Link>
      </section>
    )
  }

  const rowsToRender: number[] = []
  for (let r = r0; r <= r1; r++) rowsToRender.push(r)
  if (focus.r < r0 || focus.r > r1) rowsToRender.push(focus.r)   // la celda con foco siempre en el DOM

  const thr = rules.tremorThreshold

  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-3 mb-2">
        <h1 className="text-2xl font-bold">{file.name}</h1>
        <span className="text-sm">{file.rows} × {file.cols} · umbral {thr} · conectividad {rules.connectivity} · grupos {rules.minGroupSize}-{rules.maxGroupSize}</span>
        <Link to="/files" className="underline text-sm ml-auto">Volver</Link>
      </div>

      <div className="flex flex-col lg:flex-row gap-4">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          role="grid"
          aria-label={`Grilla del archivo ${file.name}. Flechas para moverse, Enter para seleccionar el grupo, 1 a 4 para enviarlo a una caja.`}
          aria-rowcount={file.rows}
          aria-colcount={file.cols}
          aria-busy={selecting}
          className="relative overflow-auto border rounded flex-1 select-none"
          style={{ height: 'min(70vh, 640px)', maxWidth: 1200 }}
        >
          <div style={{ position: 'relative', width: file.cols * CELL, height: file.rows * CELL }}>
            {rowsToRender.map((r) => {
              const cols: number[] = []
              if (r >= r0 && r <= r1) for (let c = c0; c <= c1; c++) cols.push(c)
              if (r === focus.r && (focus.c < c0 || focus.c > c1 || r < r0 || r > r1)) cols.push(focus.c)
              return (
                <div key={r} role="row" aria-rowindex={r + 1} style={{ position: 'absolute', top: r * CELL, left: 0, height: CELL }}>
                  {cols.map((c) => {
                    const info = store.cell(r, c)
                    const isFocus = focus.r === r && focus.c === c
                    const selected = group?.ids.has(r * file.cols + c) ?? false
                    let cls = 'cell'
                    if (!info) cls += ' cell-empty'
                    else if (info.bin !== '.') cls += ` bin-${info.bin}`
                    else if (info.tremor >= thr) cls += ` cell-scary ${info.tremor >= 90 ? 'shake-3' : info.tremor >= 75 ? 'shake-2' : 'shake-1'}`
                    if (selected) cls += ' cell-selected'
                    return (
                      <div
                        key={c}
                        role="gridcell"
                        aria-colindex={c + 1}
                        aria-selected={selected}
                        data-cell={`${r}:${c}`}
                        tabIndex={isFocus ? 0 : -1}
                        className={cls}
                        style={{ left: c * CELL, width: CELL, height: CELL, touchAction: selected ? 'none' : undefined }}
                        onClick={() => {
                          focusInGrid.current = true
                          setFocus({ r, c })
                          void selectAt({ r, c })
                        }}
                        onPointerDown={(e) => onCellPointerDown(e, r, c)}
                      >
                        {info ? info.digit : ''}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>

        <aside className="lg:w-72 space-y-3">
          <div aria-live="polite" className="border rounded p-3 text-sm min-h-24">
            {selecting && <p>Buscando el grupo completo…</p>}
            {!selecting && group && (
              <>
                <p className="font-semibold">Grupo seleccionado: {group.tooBig ? `más de ${rules.maxGroupSize}` : group.cells.length} celdas</p>
                {group.noise
                  ? <p>Es <strong>ruido</strong>: no se puede refinar.</p>
                  : <p>Caja según las reglas: <strong>{group.bin}</strong>. Arrástralo a una caja o pulsa 1-4.</p>}
              </>
            )}
            {!selecting && !group && <p>Elige una celda que da miedo (clic o Enter) para seleccionar su grupo.</p>}
            {message && <p className="mt-2">{message}</p>}
          </div>

          {!canRefine && <p className="text-sm">Tu cuenta no tiene permiso para refinar (files:refine).</p>}

          <ul className="space-y-2">
            {BINS.map((b, i) => (
              <li key={b}>
                <button
                  type="button"
                  data-bin={b}
                  onClick={() => void refine(b)}
                  disabled={!group || group.noise || busy || !canRefine}
                  aria-label={`Enviar el grupo a ${b} (tecla ${i + 1}). Progreso ${Math.round(file.progress[b] * 100)}%`}
                  className={`w-full text-left border-2 rounded p-2 bin-box bin-${LETTER[b]} ${group?.bin === b ? 'ring-2 ring-black' : ''} disabled:opacity-60`}
                >
                  <span className="font-bold">{i + 1}. {b}</span>
                  <span className="float-right">{Math.round(file.progress[b] * 100)}%</span>
                  <progress className="w-full block mt-1" max={1} value={file.progress[b]} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <p className="text-sm">
            Total: {Math.round(file.progress.overall * 100)}% · {file.refinedGroups}/{file.totalGroups} grupos · errores {file.mistakes}
          </p>
          {busy && <p role="status" className="text-sm">Refinando…</p>}
        </aside>
      </div>

      {drag && group && (
        <div className="fixed pointer-events-none z-50 px-2 py-1 rounded bg-black text-white text-sm"
          style={{ left: drag.x + 12, top: drag.y + 12 }}>
          Grupo de {group.cells.length} celdas
        </div>
      )}
    </section>
  )
}
