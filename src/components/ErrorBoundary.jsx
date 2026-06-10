import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

/**
 * Last-resort guard against a React tree that throws during render. Without
 * this, an exception in any component crashes the whole SPA to a blank page.
 * The boundary catches it, logs to the console for debugging, and offers a
 * reload button so the user isn't stranded.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-ink-50 p-6">
        <div className="card max-w-md w-full p-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-50 text-red-600 mb-4">
            <AlertCircle size={22} />
          </div>
          <h1 className="text-lg font-semibold">Algo salió mal</h1>
          <p className="text-sm text-ink-500 mt-2">
            La aplicación encontró un error inesperado. Recarga la página para continuar.
          </p>
          <pre className="surface-subtle mt-4 text-[11px] text-ink-500 p-3 text-left overflow-x-auto whitespace-pre-wrap break-words">
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-primary w-full justify-center mt-5"
          >
            <RefreshCw size={14} /> Recargar
          </button>
        </div>
      </div>
    );
  }
}
