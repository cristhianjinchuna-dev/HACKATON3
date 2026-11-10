import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vercel define VERCEL_GIT_COMMIT_SHA durante el build.
// Lo inyectamos como constante: en local no existe y queda "dev".
const sha = process.env.VERCEL_GIT_COMMIT_SHA

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __LUMON_BUILD__: JSON.stringify(sha ? sha.slice(0, 7) : 'dev'),
  },
})