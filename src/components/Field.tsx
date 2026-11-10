import type { InputHTMLAttributes } from 'react'

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  name: string
  error?: string
}

// Input con label y error del servidor junto al campo (accesible)
export default function Field({ label, name, error, ...rest }: Props) {
  const errId = `${name}-error`
  return (
    <div className="mb-3">
      <label htmlFor={name} className="block text-sm font-medium mb-1">{label}</label>
      <input
        id={name}
        name={name}
        {...rest}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        className="w-full border rounded px-3 py-2"
      />
      {error && <p id={errId} className="text-sm text-red-700 mt-1">{error}</p>}
    </div>
  )
}