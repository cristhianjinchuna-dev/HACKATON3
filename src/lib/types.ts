// Tipos copiados de los schemas del Swagger
export type Permission =
  | 'files:read' | 'files:refine'
  | 'refiners:read' | 'refiners:write'
  | 'media:upload'
  | 'incidents:read' | 'incidents:create'
  | 'team:manage'

export interface User { id: number; email: string; displayName: string }

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }
export interface LoginResponse extends TokenPair { user: User }
export interface RegisterResponse extends LoginResponse { team: { code: string; name: string } }

export interface Me {
  id: number
  email: string
  displayName: string
  team: { code: string; name: string }
  role: { code: string; name: string }   // solo para mostrar; la UI se decide por permissions
  permissions: Permission[]
  clearance: { granted: boolean; grantedAt: string | null }
}

export interface Check { name: string; passed: boolean; detail: string }

export interface ClearanceCheckResult { granted: boolean; grantedAt: string | null; checks: Check[] }

export interface IntegrationStatus {
  deploy: { origin: string | null; verifiedAt: string | null; lastBuildSeen: string | null; lastBuildSeenAt: string | null }
  storage: { provider: string | null; verifiedAt: string | null; checks: Check[] | null }
}