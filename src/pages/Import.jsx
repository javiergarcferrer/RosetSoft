import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, CheckCircle2, AlertCircle, Image as ImageIcon } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { importPdf, commitImport } from '../parser/importer.js';

export default function Import() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [phase, setPhase] = useState('idle'); // idle | parsing | preview | committing | done | error
  const [progress, setProgress] = useState({ page: 0, total: 0, stage: '' });
  const [commitProgress, setCommitProgress] = useState({ done: 0, total: 0 });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState('');
  const [counts, setCounts] = useState(null);
  const [tab, setTab] = useState('fabrics');
  const [extractImages, setExtractImages] = useState(true);

  async function onFile(file) {
    if (!file) return;
    setFileName(file.name);
    setPhase('parsing');
    setError(null);
    setProgress({ page: 0, total: 0, stage: '' });
    try {
      const result = await importPdf(file, {
        extractImages,
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
    setCommitProgress({ done: 0, total: 0 });
    try {
      const c = await commitImport(preview, {
        merge: true,
        onProgress: ({ done, total }) => setCommitProgress({ done, total }),
      });
      setCounts(c);
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
            <div className="text-sm text-ink-500 mt-1">…o haz clic para elegir archivo. Los productos y telas existentes se fusionan (no se sobreescriben).</div>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <div className="mt-6 inline-flex items-center gap-2 px-3 py-1.5 bg-ink-100 rounded-full text-xs text-ink-600">
              <FileText size={12} /> PDFs grandes (50+ MB) tardan unos minutos
            </div>
          </div>
          <div className="mt-4 card card-pad">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={extractImages}
                onChange={(e) => setExtractImages(e.target.checked)}
                className="w-4 h-4"
              />
              <div className="flex-1">
                <div className="font-medium text-sm flex items-center gap-2"><ImageIcon size={14} /> Extraer dibujos vectoriales</div>
                <div className="text-xs text-ink-500 mt-0.5">
                  Renderiza cada página y recorta los pequeños dibujos técnicos junto a cada producto / variante. Aumenta el tiempo de importación pero llena el catálogo con imágenes automáticamente.
                </div>
              </div>
            </label>
          </div>
        </>
      )}

      {phase === 'parsing' && (
        <div className="card card-pad text-center py-16">
          <div className="text-sm text-ink-500 mb-2">
            {progress.stage === 'rendering' ? 'Extrayendo dibujos de' : 'Procesando'} {fileName}
          </div>
          <div className="text-2xl font-semibold tabular-nums">{progress.page} / {progress.total || '?'}</div>
          <div className="w-full max-w-md mx-auto mt-4 h-1.5 bg-ink-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 transition-all"
              style={{ width: `${progress.total ? (progress.page / progress.total) * 100 : 0}%` }}
            />
          </div>
          {extractImages && (
            <div className="text-[11px] text-ink-500 mt-3">
              Renderizar cada página tarda ~1s. Si va lento, desmarca <i>Extraer dibujos</i> y vuelve a intentar.
            </div>
          )}
        </div>
      )}

      {phase === 'preview' && preview && (
        <>
          <div className="card card-pad mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Listo: {fileName}</div>
              <div className="text-xs text-ink-500">
                {preview.fabrics.length} {preview.fabrics.length === 1 ? 'tela/cuero' : 'telas/cueros'} ·{' '}
                {preview.products.length} {preview.products.length === 1 ? 'producto' : 'productos'} ·{' '}
                {preview.products.reduce((a, p) => a + p.variantCount, 0)} variantes
                {preview.imageCount ? ` · ${preview.imageCount} ${preview.imageCount === 1 ? 'dibujo extraído' : 'dibujos extraídos'}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={reset} className="btn-ghost">Cancelar</button>
              <button onClick={commit} className="btn-primary">Guardar en el catálogo</button>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="flex border-b border-ink-100 px-2">
              <Tab active={tab === 'fabrics'} onClick={() => setTab('fabrics')}>Materials ({preview.fabrics.length})</Tab>
              <Tab active={tab === 'products'} onClick={() => setTab('products')}>Products ({preview.products.length})</Tab>
            </div>

            {tab === 'fabrics' && (
              <div className="max-h-[60vh] overflow-y-auto">
                <table className="table">
                  <thead className="sticky top-0 bg-white z-10">
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Grade</th>
                      <th>Wear</th>
                      <th>Width</th>
                      <th>Price</th>
                      <th>Colors</th>
                      <th>Composition</th>
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
                      <th>Imagen</th>
                      <th>Nombre</th>
                      <th>Categoría</th>
                      <th>Diseñador</th>
                      <th>Variantes</th>
                      <th>Imágenes</th>
                      <th>Página(s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.products.map((p, i) => (
                      <PreviewProductRow key={i} product={p} />
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
          <div className="text-sm text-ink-500 mb-2">
            {commitProgress.total > 0 ? 'Subiendo imágenes al catálogo' : 'Guardando en el catálogo'}
          </div>
          {commitProgress.total > 0 ? (
            <>
              <div className="text-2xl font-semibold tabular-nums">
                {commitProgress.done} / {commitProgress.total}
              </div>
              <div className="w-full max-w-md mx-auto mt-4 h-1.5 bg-ink-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 transition-all"
                  style={{ width: `${commitProgress.total ? (commitProgress.done / commitProgress.total) * 100 : 0}%` }}
                />
              </div>
              <div className="text-[11px] text-ink-500 mt-3">
                Cada imagen se sube a Supabase Storage. Si la red está lenta esto puede tomar varios minutos.
              </div>
            </>
          ) : (
            <div className="text-[11px] text-ink-500">Casi listo…</div>
          )}
        </div>
      )}

      {phase === 'done' && counts && (
        <div className="card card-pad text-center py-16">
          <CheckCircle2 size={36} className="mx-auto text-emerald-500 mb-3" />
          <div className="text-base font-semibold">Importado.</div>
          <div className="text-sm text-ink-500 mt-1">
            +{counts.products} productos · +{counts.variants} variantes · +{counts.materials} telas · +{counts.colors} colores · +{counts.categories} categorías
            {counts.images ? ` · +${counts.images} imágenes` : ''}
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
          <div className="text-base font-semibold">No se pudo procesar el PDF.</div>
          <div className="text-xs text-ink-500 mt-1 max-w-md mx-auto whitespace-pre-wrap">{error}</div>
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

/**
 * Preview row that renders the extracted hero/variant blobs directly from the
 * in-memory preview data (before commit). Lets you visually verify image
 * extraction before saving anything to IndexedDB.
 */
function PreviewProductRow({ product }) {
  const variantImages = (product.variants || []).filter((v) => v.imageBlob).length;
  return (
    <tr>
      <td className="w-16">
        {product.heroBlob ? (
          <BlobThumb blob={product.heroBlob} />
        ) : (
          <div className="w-12 h-9 rounded bg-ink-100 text-[9px] text-ink-400 flex items-center justify-center">—</div>
        )}
      </td>
      <td className="font-medium">{product.name}</td>
      <td className="text-xs text-ink-600">{product.categoryName || '—'}</td>
      <td className="text-xs text-ink-600">{product.designer || '—'}</td>
      <td>{product.variantCount}</td>
      <td className="text-xs">
        {variantImages > 0 ? (
          <span className="text-emerald-700 font-medium">{variantImages}/{product.variantCount}</span>
        ) : (
          <span className="text-ink-400">0/{product.variantCount}</span>
        )}
      </td>
      <td className="text-xs text-ink-500">{(product.pages || []).join(', ')}</td>
    </tr>
  );
}

function BlobThumb({ blob }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  if (!url) return null;
  return <img src={url} className="w-12 h-9 object-cover rounded border border-ink-100" alt="" />;
}
