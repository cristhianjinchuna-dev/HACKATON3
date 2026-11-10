// URLs desde variables de entorno (nunca hardcodeadas)
export const API_URL: string = import.meta.env.VITE_API_BASE_URL
export const WS_URL: string = import.meta.env.VITE_WS_BASE_URL

// X-Lumon-Build: "dev" en localhost; en producción, el SHA del commit (inyectado en el build)
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
export const BUILD: string = isLocal ? 'dev' : __LUMON_BUILD__