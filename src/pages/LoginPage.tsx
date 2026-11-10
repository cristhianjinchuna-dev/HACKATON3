import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import Field from '../components/Field'
import { errorMessage, fieldErrors } from '../lib/errors'

export default function LoginPage() {
  const { login, notice } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setFields({})
    try {
      await login(email, password)   // PublicOnly redirige solo a la ruta original
    } catch (err) {
      setFields(fieldErrors(err))
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen grid place-items-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm border rounded p-6" noValidate>
        <h1 className="text-2xl font-bold mb-4">Iniciar sesión</h1>
        {notice && <p role="alert" className="mb-3 p-2 rounded bg-amber-100">{notice}</p>}
        <Field label="Email" name="email" type="email" autoComplete="email" required
          value={email} onChange={(e) => setEmail(e.target.value)} error={fields.email} />
        <Field label="Contraseña" name="password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} error={fields.password} />
        {error && <p role="alert" className="mb-3 text-red-700">{error}</p>}
        <button type="submit" disabled={busy} className="w-full py-2 rounded bg-teal-700 text-white disabled:opacity-50">
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        <p className="mt-4 text-sm">
          ¿Sin cuenta? <Link to="/register" state={location.state} className="underline">Registrar cuadrilla</Link>
        </p>
      </form>
    </main>
  )
}