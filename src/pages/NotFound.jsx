import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="h-full flex items-center justify-center py-20 px-4">
      <div className="text-center max-w-sm">
        {/* Icon in a tinted circle — two-ring effect for depth */}
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-brand-50 text-brand-500 mb-6 shadow-soft ring-1 ring-brand-100">
          <Compass size={32} strokeWidth={1.5} aria-hidden />
        </div>
        {/* Oversized soft 404 hint */}
        <div className="eyebrow mb-2">Error 404</div>
        <h1 className="font-display text-2xl font-semibold text-ink-900">Página no encontrada</h1>
        <p className="text-sm text-ink-500 mt-3 leading-relaxed max-w-xs mx-auto">
          El enlace que seguiste no existe o el registro fue eliminado.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3 justify-center">
          <Link to="/" className="btn-brand active:scale-[0.98] transition-transform">Volver al inicio</Link>
          <Link to="/quotes" className="btn-ghost active:scale-[0.98] transition-transform">Ver cotizaciones</Link>
        </div>
      </div>
    </div>
  );
}
