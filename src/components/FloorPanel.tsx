import { useEffect, useState } from 'react'
import type { FloorClient } from '../mdr/floor'

// Estado de la conexión y lista de presentes. Quien está fuera de la vista se puede ir a ver.
export default function FloorPanel({ floor, myUserId, onGoTo }: { floor: FloorClient; myUserId: number; onGoTo: (r: number, c: number) => void }) {
  const [, setTick] = useState(0)
  useEffect(() => floor.onState(() => setTick((t) => t + 1)), [floor])
  useEffect(() => floor.onCursors(() => setTick((t) => t + 1)), [floor])
  return (
    <div className="border rounded p-3 text-sm" aria-live="polite">
      <p className="font-semibold">Piso compartido: {floor.status}</p>
      <ul className="mt-1 space-y-1">
        {[...floor.members.values()].map((m) => {
          const pos = floor.cursors.get(m.userId)
          return (
            <li key={m.userId} className="flex items-center justify-between gap-2">
              <span>{m.displayName}{m.userId === myUserId ? ' (tú)' : ''}</span>
              {pos && m.userId !== myUserId && (
                <button type="button" className="px-2 border rounded text-xs" onClick={() => onGoTo(pos.r, pos.c)}>
                  Ir a ({pos.r}, {pos.c})
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
