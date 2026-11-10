import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { WS_URL } from '../lib/config'

interface Member { userId: number; displayName: string }
const FINAL = new Set([4400, 4403, 4404, 4423])   // cierres definitivos: no reconectar

// Piso compartido: WebSocket nativo con ticket nuevo por conexión, ping, seq/resync, presentes y reconexión
export default function FloorPanel({ fileId }: { fileId: number }) {
  const [status, setStatus] = useState('conectando')
  const [members, setMembers] = useState<Member[]>([])

  useEffect(() => {
    let ws: WebSocket | null = null
    let stopped = false
    let attempt = 0
    let retry = 0
    let pingTimer = 0
    let missed = 0
    let seq = -1

    const connect = async () => {
      if (stopped) return
      setStatus(attempt ? 'reconectando' : 'conectando')
      try {
        const t = await api<{ ticket: string }>('/floor/tickets', { method: 'POST', body: { fileId } })
        if (stopped) return
        ws = new WebSocket(`${WS_URL}/floor/ws?ticket=${encodeURIComponent(t.ticket)}`)
      } catch {
        schedule(1000 * 2 ** attempt++)
        return
      }
      const sock = ws
      sock.onopen = () => {
        attempt = 0
        missed = 0
        setStatus('conectado')
        pingTimer = window.setInterval(() => {
          if (missed >= 2) { sock.close(); return }   // dos pong sin llegar: conexión muerta
          missed++
          sock.send(JSON.stringify({ type: 'ping', t: Date.now() }))
        }, 15000)
      }
      sock.onmessage = (ev) => {
        let m: { type?: string; seq?: number; members?: Member[]; userId?: number; displayName?: string }
        try { m = JSON.parse(String(ev.data)) } catch { return }
        if (m.type === 'pong') { missed = 0; return }
        if (typeof m.seq === 'number' && m.type !== 'snapshot') {
          if (seq >= 0 && m.seq !== seq + 1) { sock.send(JSON.stringify({ type: 'resync' })); return }   // salto de seq
          seq = m.seq
        }
        if (m.type === 'snapshot') {
          seq = m.seq ?? -1
          const unique = new Map<number, Member>()
          for (const x of m.members ?? []) unique.set(x.userId, x)   // sin duplicados
          setMembers([...unique.values()])
        } else if (m.type === 'member.joined' && m.userId !== undefined) {
          const { userId, displayName = '' } = m
          setMembers((all) => (all.some((x) => x.userId === userId) ? all : [...all, { userId, displayName }]))
        } else if (m.type === 'member.left' && m.userId !== undefined) {
          setMembers((all) => all.filter((x) => x.userId !== m.userId))
        }
      }
      sock.onclose = (ev) => {
        window.clearInterval(pingTimer)
        setMembers([])
        if (stopped) return
        if (FINAL.has(ev.code)) { setStatus(`cerrado (${ev.code}): ${ev.reason || 'no se reconecta'}`); return }
        if (ev.code === 4429) { schedule(10000); return }
        schedule(Math.min(30000, 1000 * 2 ** attempt++))
      }
    }
    const schedule = (ms: number) => {
      setStatus('reconectando')
      retry = window.setTimeout(() => void connect(), ms)
    }
    void connect()
    return () => {
      stopped = true
      window.clearTimeout(retry)
      window.clearInterval(pingTimer)
      ws?.close()
    }
  }, [fileId])

  return (
    <div className="border rounded p-3 text-sm" aria-live="polite">
      <p className="font-semibold">Piso compartido: {status}</p>
      <ul>{members.map((m) => <li key={m.userId}>{m.displayName}</li>)}</ul>
    </div>
  )
}
