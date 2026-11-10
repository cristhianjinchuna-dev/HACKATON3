import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import Field from '../components/Field'
import { errorMessage, fieldErrors } from '../lib/errors'

export default function RegisterPage() {
  const { register } = useAuth()
  const location = useLocation()
  const [teamName, setTeamName] = useState('')
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
      await register(teamName, email, password)   // entra directo con la sesión iniciada
    } catch (err) {
      const f = fieldErrors(err)                    // EMAIL_TAKEN -> email, TEAM_NAME_TAKEN -> teamName
      setFields(f)
      if (Object.keys(f).length === 0 || f._) setError(f._ ?? errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen grid place-items-center p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm border rounded p-6" noValidate>
        <h1 className="text-2xl font-bold mb-4">Registrar cuadrilla</h1>
        <Field label="Nombre de la cuadrilla (3 a 40)" name="teamName" required minLength={3} maxLength={40}
          value={teamName} onChange={(e) => setTeamName(e.target.value)} error={fields.teamName} />
        <Field label="Email" name="email" type="email" autoComplete="email" required maxLength={120}
          value={email} onChange={(e) => setEmail(e.target.value)} error={fields.email} />
        <Field label="Contraseña (8 a 72)" name="password" type="password" autoComplete="new-password" required
          minLength={8} maxLength={72}
          value={password} onChange={(e) => setPassword(e.target.value)} error={fields.password} />
        {error && <p role="alert" className="mb-3 text-red-700">{error}</p>}
        <button type="submit" disabled={busy} className="w-full py-2 rounded bg-teal-700 text-white disabled:opacity-50">
          {busy ? 'Registrando…' : 'Registrar'}
        </button>
        <p className="mt-4 text-sm">
          ¿Ya tienen cuenta? <Link to="/login" state={location.state} className="underline">Iniciar sesión</Link>
        </p>
      </form>
    </main>
  )
}