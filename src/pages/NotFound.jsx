import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="h-full flex items-center justify-center py-20">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-ink-100 text-ink-500 mb-3">
          <Compass size={22} />
        </div>
        <h1 className="text-lg font-semibold">Página no encontrada</h1>
        <p className="text-sm text-ink-500 mt-2">
          El enlace que seguiste no existe o el registro fue eliminado.
        </p>
        <div className="mt-5 flex items-center gap-2 justify-center">
          <Link to="/" className="btn-primary">Volver al inicio</Link>
          <Link to="/quotes" className="btn-ghost">Ver cotizaciones</Link>
        </div>
      </div>
    </div>
  );
}
