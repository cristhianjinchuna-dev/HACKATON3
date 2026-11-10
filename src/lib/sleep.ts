// Espera que se puede cancelar con AbortController
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Espera creciente (1s, 2s, 4s… máx 15s), pero NUNCA menos que Retry-After
export function retryDelay(retryAfter: number | null, attempt: number): number {
  const backoff = Math.min(1000 * 2 ** attempt, 15000)
  return Math.max((retryAfter ?? 0) * 1000, backoff) + Math.random() * 250
}
