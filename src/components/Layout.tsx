import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import ErrorBoundary from './ErrorBoundary'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1 rounded ${isActive ? 'bg-teal-700 text-white' : 'hover:bg-teal-100'}`

export default function Layout() {
  const { me, can, logout } = useAuth()
  const { pathname } = useLocation()

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b px-4 py-2 flex flex-wrap items-center gap-2">
        <span className="font-bold mr-4">Lumon · MDR</span>
        <nav aria-label="Principal" className="flex flex-wrap gap-1">
          <NavLink to="/" end className={linkClass}>Inicio</NavLink>
          {/* Se muestra según permissions, no según rol */}
          {can('files:read') && <NavLink to="/files" className={linkClass}>Archivos</NavLink>}
          <NavLink to="/estado" className={linkClass}>Estado</NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span>{me?.displayName} · {me?.team.code}</span>
          <button type="button" onClick={() => void logout()} className="px-3 py-1 rounded border">
            Cerrar sesión
          </button>
        </div>
      </header>
      <main className="flex-1 p-4">
        {/* key: al cambiar de ruta se limpia el error */}
        <ErrorBoundary key={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}