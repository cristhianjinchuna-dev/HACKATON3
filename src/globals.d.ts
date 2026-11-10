// Le dice a TypeScript que existe la constante que inyecta vite.config.ts
export {}

declare global {
  const __LUMON_BUILD__: string
}