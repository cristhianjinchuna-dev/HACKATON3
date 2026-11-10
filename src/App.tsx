import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { PublicOnly, RequireAuth, RequirePermission } from './auth/guards'
import HealthGate from './components/HealthGate'
import Layout from './components/Layout'
import EstadoPage from './pages/EstadoPage'
import FilesPage from './pages/FilesPage'
import HomePage from './pages/HomePage'
import LoginPage from './pages/LoginPage'
import NotFoundPage from './pages/NotFoundPage'
import RegisterPage from './pages/RegisterPage'

export default function App() {
  return (
    <HealthGate>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Públicas: si ya hay sesión, redirigen */}
            <Route element={<PublicOnly />}>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
            </Route>

            {/* Privadas */}
            <Route element={<RequireAuth />}>
              <Route element={<Layout />}>
                <Route index element={<HomePage />} />
                <Route path="estado" element={<EstadoPage />} />
                <Route element={<RequirePermission perm="files:read" />}>
                  <Route path="files" element={<FilesPage />} />
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </HealthGate>
  )
}