import { useEffect, useState } from 'react'
import type { FloorClient } from '../mdr/floor'

// Capa aparte: los cursores que llegan solo re-renderizan ESTA capa, nunca la grilla
export default function CursorLayer({ floor, cell, r0, r1, c0, c1 }: { floor: FloorClient; cell: number; r0: number; r1: number; c0: number; c1: number }) {
  const [, setTick] = useState(0)
  useEffect(() => floor.onCursors(() => setTick((t) => t + 1)), [floor])
  const items: { id: number; r: number; c: number; name: string }[] = []
  floor.cursors.forEach((p, id) => {
    if (p.r >= r0 && p.r <= r1 && p.c >= c0 && p.c <= c1) items.push({ id, ...p, name: floor.members.get(id)?.displayName ?? '' })
  })
  return (
    <>
      {items.map((x) => (
        <div key={x.id} aria-hidden="true" className="absolute pointer-events-none border-2 border-orange-500 z-10"
          style={{ top: x.r * cell, left: x.c * cell, width: cell, height: cell }}>
          <span className="absolute -top-4 left-0 text-[10px] bg-orange-500 text-white px-1 whitespace-nowrap">{x.name}</span>
        </div>
      ))}
    </>
  )
}
