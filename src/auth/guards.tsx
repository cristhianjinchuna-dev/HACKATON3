import { Link, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'
import type { Permission } from '../lib/types'

export function FullScreen({ text }: { text: string }) {
  return (
    <div className="min-h-screen grid place-items-center" role="status" aria-live="polite">
      <p className="text-lg">{text}</p>
    </div>
  )
}

// Ruta privada: sin sesión -> /login, guardando ruta + query string para volver después
export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'checking') return <FullScreen text="Verificando sesión…" />
  if (status === 'anon') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  return <Outlet />
}

// Login/registro: si ya hay sesión, volver a donde quería ir (o al inicio)
export function PublicOnly() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'checking') return <FullScreen text="Verificando sesión…" />
  if (status === 'auth') {
    const from = (location.state as { from?: string } | null)?.from ?? '/'
    return <Navigate to={from} replace />
  }
  return <Outlet />
}

// Ruta que exige un permiso: sin él -> página "sin permiso" (no error, no pantalla en blanco)
export function RequirePermission({ perm }: { perm: Permission }) {
  const { can } = useAuth()
  if (!can(perm)) {
    return (
      <section className="p-6">
        <h1 className="text-2xl font-bold mb-2">Sin permiso</h1>
        <p className="mb-4">Tu cuenta no tiene el permiso <code>{perm}</code> para ver esta página.</p>
        <Link to="/" className="underline">Volver al inicio</Link>
      </section>
    )
  }
  return <Outlet />
}