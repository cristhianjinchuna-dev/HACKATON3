import type { Bin, FileItem, Rules } from '../lib/types'
import { tileKey, type TileStore } from './tileStore'

export interface Cell { r: number; c: number }

export interface Group {
  cells: Cell[]
  ids: Set<number>        // r * cols + c, para saber rápido si una celda está seleccionada
  noise: boolean          // fuera de [minGroupSize, maxGroupSize]
  tooBig: boolean         // pasó maxGroupSize (dejamos de buscar)
  bin: Bin | null         // caja que corresponde según las reglas (null si es ruido)
}

const N4 = [[-1, 0], [1, 0], [0, -1], [0, 1]]
const N8 = [...N4, [-1, -1], [-1, 1], [1, -1], [1, 1]]

// Busca el grupo COMPLETO (BFS) desde una celda que da miedo.
// Si el grupo cruza bloques que no tenemos, los pide y vuelve a buscar.
export async function findGroup(store: TileStore, file: FileItem, rules: Rules, start: Cell): Promise<Group> {
  const dirs = rules.connectivity === 8 ? N8 : N4
  const limit = rules.maxGroupSize + 1   // con esto ya sabemos que es ruido

  for (let round = 0; round < 100; round++) {
    const seen = new Set<number>([start.r * file.cols + start.c])
    const queue: Cell[] = [start]
    const cells: Cell[] = []
    const missing = new Map<string, [number, number]>()
    let sum = 0
    let max = 0

    for (let head = 0; head < queue.length && cells.length < limit; head++) {
      const cur = queue[head]
      const info = store.cell(cur.r, cur.c)
      if (!info) {
        const tr = Math.floor(cur.r / file.tileSize)
        const tc = Math.floor(cur.c / file.tileSize)
        missing.set(tileKey(tr, tc), [tr, tc])
        continue
      }
      if (info.tremor < rules.tremorThreshold || info.bin !== '.') continue
      cells.push(cur)
      sum += info.digit
      max = Math.max(max, info.digit)
      for (const [dr, dc] of dirs) {
        const r = cur.r + dr
        const c = cur.c + dc
        if (r < 0 || c < 0 || r >= file.rows || c >= file.cols) continue
        const id = r * file.cols + c
        if (seen.has(id)) continue
        seen.add(id)
        queue.push({ r, c })
      }
    }

    const tooBig = cells.length >= limit
    if (missing.size > 0 && !tooBig) {
      await Promise.all([...missing.values()].map(([tr, tc]) => store.load(tr, tc, { pinned: true })))
      continue   // ya llegaron los bloques que faltaban: buscar de nuevo
    }

    const noise = tooBig || cells.length < rules.minGroupSize || cells.length > rules.maxGroupSize
    const index = (rules.binning.strategy === 'DIGIT_SUM_MOD' ? sum : max) % 4
    return {
      cells,
      ids: new Set(cells.map((x) => x.r * file.cols + x.c)),
      noise,
      tooBig,
      bin: noise ? null : rules.binning.order[index],
    }
  }
  throw new Error('No se pudo cargar el grupo completo')
}
