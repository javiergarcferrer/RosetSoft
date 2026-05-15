import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, CheckCircle2, AlertCircle, Image as ImageIcon, Sparkles } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { importPdf, commitImport, extractAndUploadImages } from '../parser/importer.js';

/**
 * Import flow phases:
 *
 *   idle → parsing → preview → committing → committed
 *                                    ↓
 *                                 (optional) → extracting-images → done
 *
 *   committed = catalog text saved (the durable, fast part). The user can
 *   navigate away from this point and the catalog is intact.
 *   extracting-images = optional second pass that renders intro pages and
 *   uploads hero drawings to Storage. Decoupled because Storage is the most
 *   rate-limited part of Supabase free tier.
 */
export default function Import() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [phase, setPhase] = useState('idle');
  const [progress, setProgress] = useState({ page: 0, total: 0, stage: '' });
  const [commitProgress, setCommitProgress] = useState({ done: 0, total: 0, label: '' });
  const [imageProgress, setImageProgress] = useState({ done: 0, total: 0 });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState('');
  const [counts, setCounts] = useState(null);
  const [imageCounts, setImageCounts] = useState(null);
  const [tab, setTab] = useState('products');

  async function onFile(file) {
    if (!file) return;
    setFileName(file.name);
    setPhase('parsing');
    setError(null);
    setProgress({ page: 0, total: 0, stage: '' });
    try {
      const result = await importPdf(file, {
        onProgress: ({ page, total, stage }) => setProgress({ page, total, stage }),
      });
      setPreview(result);
      setPhase('preview');
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
      setPhase('error');
    }
  }

  async function commit() {
    setPhase('committing');
    setCommitProgress({ done: 0, total: 0, label: '' });
    try {
      const c = await commitImport(preview, {
        onProgress: ({ phase: ph, done, total, label }) => {
          setCommitProgress({ done, total, label: label || ph });
        },
      });
      setCounts(c);
      setPhase('committed');
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
      setPhase('error');
    }
  }

  async function runImagePass() {
    setPhase('extracting-images');
    setImageProgress({ done: 0, total: 0 });
    try {
      const r = await extractAndUploadImages(preview, {
        concurrency: 3,
        onProgress: ({ done, total }) => setImageProgress({ done, total }),
      });
      setImageCounts(r);
      setPhase('done');
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
      setPhase('error');
    }
  }

  function reset() {
    setPhase('idle');
    setPreview(null);
    setProgress({ page: 0, total: 0 });
    setError(null);
    setFileName('');
    setCounts(null);
    setImageCounts(null);
  }

  return (
    <>
      <PageHeader
        title="Import PDF"
        subtitle="Parse a Ligne Roset price list — fabrics, leathers, products, variants, and prices."
      />

      {phase === 'idle' && (
        <>
          <div
            className="card card-pad text-center py-20 border-2 border-dashed border-ink-200 cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onFile(e.dataTransfer.files?.[0]);
            }}
          >
            <Upload size={36} className="mx-auto text-ink-400 mb-3" />
            <div className="text-base font-medium">Suelta aquí un PDF de lista de precios de Ligne Roset</div>
            <div className="text-sm text-ink-500 mt-1">
              …o haz clic para elegir archivo. Los productos y telas existentes se fusionan (no se sobreescriben).
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <div className="mt-6 inline-flex items-center gap-2 px-3 py-1.5 bg-ink-100 rounded-full text-xs text-ink-600">
              <FileText size={12} /> PDFs grandes (50+ MB) tardan ~1 min en parsear
            </div>
          </div>
          <div className="mt-4 card card-pad text-xs text-ink-600 leading-relaxed">
            <div className="font-medium text-ink-900 mb-1.5 flex items-center gap-1.5"><Sparkles size={13} /> Cómo funciona</div>
            <ol className="list-decimal list-inside space-y-0.5">
              <li><b>Parsear</b> — extrae familias, productos y precios sin tocar la base de datos.</li>
              <li><b>Vista previa</b> — revisa lo extraído.</li>
              <li><b>Guardar</b> — sube todo en bloques (rápido y resistente a errores de red).</li>
              <li><b>Imágenes</b> (opcional) — extrae los dibujos de las páginas intro de cada familia.</li>
            </ol>
          </div>
        </>
      )}

      {phase === 'parsing' && (
        <div className="card card-pad text-center py-16">
          <div className="text-sm text-ink-500 mb-2">Parseando {fileName}</div>
          <div className="text-2xl font-semibold tabular-nums">{progress.page} / {progress.total || '?'}</div>
          <div className="w-full max-w-md mx-auto mt-4 h-1.5 bg-ink-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 transition-all"
              style={{ width: `${progress.total ? (progress.page / progress.total) * 100 : 0}%` }}
            />
          </div>
          <div className="text-[11px] text-ink-500 mt-3">
            Sólo lectura — todavía no se ha guardado nada.
          </div>
        </div>
      )}

      {phase === 'preview' && preview && (
        <>
          <div className="card card-pad mb-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="text-sm font-medium">Listo: {fileName}</div>
              <div className="text-xs text-ink-500">
                {preview.fabrics.length} {preview.fabrics.length === 1 ? 'tela/cuero' : 'telas/cueros'} ·{' '}
                {preview.productsPreview.length} {preview.productsPreview.length === 1 ? 'producto' : 'productos'} ·{' '}
                {preview.products.length} variantes
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={reset} className="btn-ghost">Cancelar</button>
              <button onClick={commit} className="btn-primary">Guardar en el catálogo</button>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="flex border-b border-ink-100 px-2">
              <Tab active={tab === 'products'} onClick={() => setTab('products')}>
                Products ({preview.productsPreview.length})
              </Tab>
              <Tab active={tab === 'fabrics'} onClick={() => setTab('fabrics')}>
                Materials ({preview.fabrics.length})
              </Tab>
            </div>

            {tab === 'fabrics' && (
              <div className="max-h-[60vh] overflow-y-auto">
                <table className="table">
                  <thead className="sticky top-0 bg-white z-10">
                    <tr>
                      <th>Name</th><th>Type</th><th>Grade</th><th>Wear</th>
                      <th>Width</th><th>Price</th><th>Colors</th><th>Composition</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.fabrics.map((m, i) => (
                      <tr key={i}>
                        <td className="font-medium">{m.name}</td>
                        <td className="capitalize text-xs">{m.kind.replace('-', ' ')}</td>
                        <td><span className="badge">{m.grade || '—'}</span></td>
                        <td className="text-xs text-ink-600">{m.wear || '—'}</td>
                        <td className="text-xs text-ink-600">{m.width || '—'}</td>
                        <td className="text-xs text-ink-600">${m.pricePerUnit ?? '—'}</td>
                        <td className="text-ink-500">{m.colors.length}</td>
                        <td className="text-xs text-ink-500 max-w-xs truncate" title={m.composition}>{m.composition || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'products' && (
              <div className="max-h-[60vh] overflow-y-auto">
                <table className="table">
                  <thead className="sticky top-0 bg-white z-10">
                    <tr>
                      <th>Nombre</th><th>Categoría</th><th>Diseñador</th>
                      <th className="text-right">Variantes</th>
                      <th className="text-xs">Página intro</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.productsPreview.map((p, i) => (
                      <tr key={i}>
                        <td className="font-medium">{p.name}</td>
                        <td className="text-xs text-ink-600">{p.categoryName || '—'}</td>
                        <td className="text-xs text-ink-600">{p.designer || '—'}</td>
                        <td className="text-right">{p.variantCount}</td>
                        <td className="text-xs text-ink-500">{p.family?.intro_page ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {phase === 'committing' && (
        <div className="card card-pad text-center py-16">
          <div className="text-sm text-ink-500 mb-2">{commitProgress.label || 'Guardando…'}</div>
          {commitProgress.total > 0 ? (
            <>
              <div className="text-2xl font-semibold tabular-nums">
                {commitProgress.done} / {commitProgress.total}
              </div>
              <div className="w-full max-w-md mx-auto mt-4 h-1.5 bg-ink-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 transition-all"
                  style={{ width: `${(commitProgress.done / commitProgress.total) * 100}%` }}
                />
              </div>
            </>
          ) : (
            <div className="text-[11px] text-ink-500">Iniciando…</div>
          )}
          <div className="text-[11px] text-ink-500 mt-3">
            Subida en bloques de 500 filas con reintentos automáticos.
          </div>
        </div>
      )}

      {phase === 'committed' && counts && (
        <div className="card card-pad py-12">
          <div className="text-center">
            <CheckCircle2 size={36} className="mx-auto text-emerald-500 mb-3" />
            <div className="text-base font-semibold">Catálogo guardado.</div>
            <div className="text-sm text-ink-500 mt-1">
              +{counts.products} productos · +{counts.variants} variantes · +{counts.materials} materiales · +{counts.colors} colores · +{counts.categories} categorías
            </div>
          </div>

          <div className="border-t border-ink-100 mt-8 pt-6 max-w-2xl mx-auto">
            <div className="flex items-start gap-3">
              <ImageIcon size={20} className="text-ink-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-medium text-sm">Extraer dibujos de los productos (opcional)</div>
                <div className="text-xs text-ink-500 mt-1 leading-relaxed">
                  Renderiza cada página intro de familia y sube el dibujo principal.
                  Más lento porque cada imagen es una petición a Storage — si Supabase
                  está saturado puedes reintentar más tarde sin perder datos.
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button onClick={runImagePass} className="btn-secondary">
                <ImageIcon size={14} /> Extraer dibujos
              </button>
              <button onClick={() => navigate('/catalog')} className="btn-primary ml-auto">
                Abrir catálogo
              </button>
              <button onClick={reset} className="btn-ghost">Importar otro</button>
            </div>
          </div>
        </div>
      )}

      {phase === 'extracting-images' && (
        <div className="card card-pad text-center py-16">
          <div className="text-sm text-ink-500 mb-2">Extrayendo dibujos</div>
          <div className="text-2xl font-semibold tabular-nums">
            {imageProgress.done} / {imageProgress.total || '?'}
          </div>
          <div className="w-full max-w-md mx-auto mt-4 h-1.5 bg-ink-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 transition-all"
              style={{ width: `${imageProgress.total ? (imageProgress.done / imageProgress.total) * 100 : 0}%` }}
            />
          </div>
          <div className="text-[11px] text-ink-500 mt-3">
            Cada imagen es una subida a Supabase Storage — concurrencia limitada a 3.
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="card card-pad text-center py-16">
          <CheckCircle2 size={36} className="mx-auto text-emerald-500 mb-3" />
          <div className="text-base font-semibold">Importado.</div>
          <div className="text-sm text-ink-500 mt-1">
            {counts && (
              <>+{counts.products} productos · +{counts.variants} variantes · +{counts.materials} materiales · +{counts.colors} colores</>
            )}
            {imageCounts && (
              <div className="mt-1">
                Imágenes: {imageCounts.uploaded} subidas · {imageCounts.failed} fallidas
                {imageCounts.failed > 0 && ' (puedes volver a ejecutar “Extraer dibujos” para reintentar)'}
              </div>
            )}
          </div>
          <div className="mt-5 flex items-center gap-2 justify-center">
            <button onClick={reset} className="btn-secondary">Importar otro</button>
            <button onClick={() => navigate('/catalog')} className="btn-primary">Abrir catálogo</button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="card card-pad text-center py-12 border-red-200">
          <AlertCircle size={28} className="mx-auto text-red-500 mb-2" />
          <div className="text-base font-semibold">Hubo un problema.</div>
          <div className="text-xs text-ink-500 mt-1 max-w-xl mx-auto whitespace-pre-wrap break-words">{error}</div>
          {counts && (
            <div className="text-[11px] text-emerald-600 mt-3">
              El catálogo de texto sí se guardó ({counts.products} productos · {counts.variants} variantes).
              El error ocurrió en la fase de imágenes.
            </div>
          )}
          <button onClick={reset} className="btn-secondary mt-5">Probar otro archivo</button>
        </div>
      )}
    </>
  );
}

function Tab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
        active ? 'border-ink-900 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-900'
      }`}
    >
      {children}
    </button>
  );
}
