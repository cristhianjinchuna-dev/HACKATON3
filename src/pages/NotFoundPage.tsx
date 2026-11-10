import { Link } from 'react-router-dom'

export default function NotFoundPage() {
  return (
    <main className="min-h-screen grid place-items-center p-6 text-center">
      <div>
        <h1 className="text-4xl font-bold mb-2">404</h1>
        <p className="mb-4">Esta ruta no existe.</p>
        <Link to="/" className="underline">Volver al inicio</Link>
      </div>
    </main>
  )
}