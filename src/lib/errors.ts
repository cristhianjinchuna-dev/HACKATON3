// Error de la API con el cuerpo estándar { error, message, details, ... }
export class ApiError extends Error {
  readonly status: number
  readonly code: string          // decidimos SIEMPRE por este campo ("error" del body)
  readonly details: unknown
  readonly retryAfter: number | null

  constructor(status: number, code: string, message: string, details: unknown, retryAfter: number | null) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.retryAfter = retryAfter
  }
}

function isErrorBody(b: unknown): b is { error: string; message?: string; details?: unknown } {
  return typeof b === 'object' && b !== null && typeof (b as { error?: unknown }).error === 'string'
}

// Convierte una Response fallida en ApiError (lee Retry-After si viene)
export async function toApiError(res: Response): Promise<ApiError> {
  const ra = res.headers.get('Retry-After')
  const retryAfter = ra !== null && /^\d+$/.test(ra) ? Number(ra) : null
  try {
    const body: unknown = await res.json()
    if (isErrorBody(body)) {
      return new ApiError(res.status, body.error, body.message ?? body.error, body.details ?? null, retryAfter)
    }
  } catch {
    // el cuerpo no era JSON
  }
  return new ApiError(res.status, `HTTP_${res.status}`, res.statusText || 'Error de red', null, retryAfter)
}

// Errores por campo: VALIDATION_ERROR -> details.fields ; 409 -> details.field
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || typeof e.details !== 'object' || e.details === null) return {}
  const d = e.details as { fields?: unknown; field?: unknown }
  if (e.code === 'VALIDATION_ERROR' && typeof d.fields === 'object' && d.fields !== null) {
    return d.fields as Record<string, string>
  }
  if (typeof d.field === 'string') return { [d.field]: e.message }
  return {}
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return 'Error inesperado'
}