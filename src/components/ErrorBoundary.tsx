import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

// Un error de render en una ruta NO deja la app en blanco: muestra un mensaje con opción de volver
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Error de render:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <section role="alert" className="p-6">
          <h1 className="text-2xl font-bold mb-2">Algo salió mal en esta pantalla</h1>
          <p className="mb-4">{this.state.error.message}</p>
          <div className="flex gap-3">
            <button type="button" onClick={() => this.setState({ error: null })} className="px-3 py-1 border rounded">
              Reintentar
            </button>
            <a href="/" className="px-3 py-1 border rounded">Volver al inicio</a>
          </div>
        </section>
      )
    }
    return this.props.children
  }
}
