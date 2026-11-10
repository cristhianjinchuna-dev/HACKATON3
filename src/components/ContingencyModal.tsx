import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { onLumonEvent } from '../lib/events'

interface Contingency { id: number; userId: number; message: string }

// Modal de contingencia: aparece en TODAS las pestañas, atrapa el foco
// y solo se cierra al confirmar con POST /contingency/{id}/ack
export default function ContingencyModal() {
  const { me } = useAuth()
  const [current, setCurrent] = useState<Contingency | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(
    () =>
      onLumonEvent((e) => {
        if (e.type === 'contingency.activated') {
          const d = e.data as Contingency
          if (me && d.userId === me.id) {
            setCurrent(d)
            setError(null)
          }
        } else if (e.type === 'contingency.resolved') {
          const d = e.data as { id: number }
          setCurrent((cur) => (cur && cur.id === d.id ? null : cur))
        }
      }),
    [me],
  )

  useEffect(() => {
    if (current) buttonRef.current?.focus()
  }, [current])

  if (!current) return null

  const ack = async () => {
    setSending(true)
    setError(null)
    try {
      await api(`/contingency/${current.id}/ack`, { method: 'POST' })
      setCurrent(null)
    } catch (e) {
      setError(`No se pudo confirmar: ${errorMessage(e)} Intenta de nuevo.`)   // el modal sigue abierto
    } finally {
      setSending(false)
    }
  }

  // Foco atrapado: Tab no sale del modal y Escape no lo cierra
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab' || e.key === 'Escape') {
      e.preventDefault()
      buttonRef.current?.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4" onKeyDown={onKeyDown}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="contingency-title" aria-describedby="contingency-msg"
        className="bg-white rounded p-6 max-w-md w-full">
        <h2 id="contingency-title" className="text-xl font-bold mb-2">Contingencia de horas extra</h2>
        <p id="contingency-msg" className="mb-4">{current.message}</p>
        {error && <p role="alert" className="text-red-700 mb-3">{error}</p>}
        <button ref={buttonRef} type="button" onClick={() => void ack()} disabled={sending}
          className="px-4 py-2 rounded bg-teal-700 text-white disabled:opacity-60">
          {sending ? 'Confirmando…' : 'Confirmar'}
        </button>
      </div>
    </div>
  )
}
