import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export default function HomePage() {
  const { me, can } = useAuth()
  if (!me) return null
  return (
    <section>
      <h1 className="text-2xl font-bold mb-2">Bienvenido, {me.displayName}</h1>
      <p className="mb-4">Cuadrilla {me.team.name} ({me.team.code}) · Rol: {me.role.name}</p>
      <h2 className="font-semibold">Permisos</h2>
      <ul className="list-disc pl-6 mb-4">
        {me.permissions.map((p) => <li key={p}>{p}</li>)}
      </ul>
      {can('files:read')
        ? <Link to="/files" className="underline">Ir a Macrodata Refinement</Link>
        : <p>No tienes permiso para ver los archivos.</p>}
    </section>
  )
}