import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, CheckCircle2, AlertCircle, Image as ImageIcon, Folder, X } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { buildPreview, commitCatalog } from '../lib/catalogImport.js';

/**
 * Catalog importer UI.
 *
 * The PDF parser lives offline now (see `tarif-parser/` at repo root). The
 * user runs it locally to produce `out/catalog.json` + `out/images/*.jpg`,
 * then drops both here. The catalog.json is required; the images folder is
 * optional (the app still imports rows without images attached).
 */
export default function Import() {
  const navigate = useNavigate();
  const catalogInputRef = useRef(null);
  const imagesInputRef = useRef(null);
  const [phase, setPhase] = useState('idle'); // idle | preview | committing | done | error
  const [commitProgress, setCommitProgress] = useState({ done: 0, total: 0, label: '' });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [catalogFile, setCatalogFile] = useState(null);
  const [imageFiles, setImageFiles] = useState(null); // FileList | null
  const [counts, setCounts] = useState(null);
  const [tab, setTab] = useState('fabrics');

  /* ----- file pickers --------------------------------------------------- */

  function pickCatalog(file) {
    if (!file) return;
    if (!/\.json$/i.test(file.name)) {
      setError('El archivo del catálogo debe ser catalog.json');
      setPhase('error');
      return;
    }
    setError(null);
    setCatalogFile(file);
  }

  function pickImages(fileList) {
    if (!fileList || !fileList.length) return;
    setImageFiles(fileList);
  }

  function clearImages() {
    setImageFiles(null);
    if (imagesInputRef.current) imagesInputRef.current.value = '';
  }

  function reset() {
    setPhase('idle');
    setPreview(null);
    setError(null);
    setCatalogFile(null);
    setImageFiles(null);
    setCounts(null);
    setCommitProgress({ done: 0, total: 0, label: '' });
    if (catalogInputRef.current) catalogInputRef.current.value = '';
    if (imagesInputRef.current) imagesInputRef.current.value = '';
  }

  /* ----- process -------------------------------------------------------- */

  async function process() {
    if (!catalogFile) return;
    try {
      const text = await catalogFile.text();
      let catalog;
      try {
        catalog = JSON.parse(text);
      } catch (e) {
        throw new Error('catalog.json no es JSON válido: ' + e.message);
      }

      // Build the image lookup table. Each file is keyed by BOTH its full
      // webkitRelativePath AND its bare filename so the caller can drop
      // either the parser's `out/` directory or just `out/images/`.
      const blobs = new Map();
      if (imageFiles) {
        for (const f of imageFiles) {
          const rel = f.webkitRelativePath || f.name;
          blobs.set(rel, f);
          const base = rel.split('/').pop();
          if (base && !blobs.has(base)) blobs.set(base, f);
          // Also key by `images/<filename>` to match catalog.json paths
          // exactly when the user drops a non-`images/` folder.
          if (base && !blobs.has('images/' + base)) blobs.set('images/' + base, f);
        }
      }

      const p = buildPreview(catalog, blobs);
      setPreview(p);
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
      const c = await commitCatalog(preview, {
        merge: true,
        onProgress: ({ phase: ph, done, total }) => {
          const label =
            ph === 'planning' ? 'Preparando catálogo'
            : ph === 'uploading' ? 'Subiendo imágenes'
            : ph === 'writing' ? 'Guardando filas en la base de datos'
            : ph === 'starting' ? 'Iniciando'
            : ph === 'done' ? 'Listo'
            : '';
          setCommitProgress({ done, total, label });
        },
      });
      setCounts(c);
      setPhase('done');
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
      setPhase('error');
    }
  }

  /* ----- render --------------------------------------------------------- */

  const variantTotal = preview?.products?.reduce((a, p) => a + p.variantCount, 0) ?? 0;
  const expectedImages = preview?.expectedImages ?? 0;

  return (
    <>
      <PageHeader
        title="Importar catálogo"
        subtitle="Sube el catalog.json producido por tarif-parser, opcionalmente con la carpeta de imágenes."
      />

      {phase === 'idle' && (
        <>
          <CatalogDrop
            inputRef={catalogInputRef}
            file={catalogFile}
            onPick={pickCatalog}
            onClear={() => { setCatalogFile(null); if (catalogInputRef.current) catalogInputRef.current.value = ''; }}
          />

          <div className="mt-4 card card-pad">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <Folder size={18} className="text-ink-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium text-sm">Carpeta de imágenes (opcional)</div>
                  <div className="text-xs text-ink-500 mt-0.5">
                    Selecciona la carpeta <code className="px-1 py-0.5 bg-ink-100 rounded">out/images</code> que produjo el parser. Sin imágenes, el catálogo se importa con texto y precios pero sin fotos.
                  </div>
                  {imageFiles && (
                    <div className="text-xs text-emerald-700 mt-1 truncate">
                      {imageFiles.length} {imageFiles.length === 1 ? 'archivo' : 'archivos'} seleccionados
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {imageFiles && (
                  <button onClick={clearImages} className="btn-ghost text-xs" title="Quitar imágenes">
                    <X size={14} />
                  </button>
                )}
                <button
                  onClick={() => imagesInputRef.current?.click()}
                  className="btn-secondary text-xs"
                >
                  {imageFiles ? 'Cambiar carpeta' : 'Elegir carpeta'}
                </button>
                <input
                  ref={imagesInputRef}
                  type="file"
                  webkitdirectory=""
                  directory=""
                  multiple
                  className="hidden"
                  onChange={(e) => pickImages(e.target.files)}
                />
              </div>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-2">
            <button
              onClick={process}
              disabled={!catalogFile}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Procesar
            </button>
          </div>

          <div className="mt-4 text-xs text-ink-500">
            <details>
              <summary className="cursor-pointer hover:text-ink-700">¿Cómo genero el catalog.json?</summary>
              <div className="mt-2 pl-4 space-y-1.5">
                <div>1. Desde la raíz del repo: <code className="px-1 py-0.5 bg-ink-100 rounded">cd tarif-parser && npm install</code></div>
                <div>2. <code className="px-1 py-0.5 bg-ink-100 rounded">node index.js /ruta/al/tarif.pdf --out ./out</code></div>
                <div>3. Sube <code className="px-1 py-0.5 bg-ink-100 rounded">out/catalog.json</code> y la carpeta <code className="px-1 py-0.5 bg-ink-100 rounded">out/images</code> aquí.</div>
              </div>
            </details>
          </div>
        </>
      )}

      {phase === 'preview' && preview && (
        <>
          <div className="card card-pad mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Listo: {catalogFile?.name}</div>
              <div className="text-xs text-ink-500">
                {preview.fabrics.length} {preview.fabrics.length === 1 ? 'tela/cuero' : 'telas/cueros'} ·{' '}
                {preview.products.length} {preview.products.length === 1 ? 'producto' : 'productos'} ·{' '}
                {variantTotal} variantes
                {expectedImages > 0 && (
                  <>
                    {' · '}
                    <span className={preview.imageCount === expectedImages ? 'text-ink-500' : 'text-amber-700'}>
                      {preview.imageCount} / {expectedImages} imágenes encontradas
                    </span>
                  </>
                )}
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
            {commitProgress.label || (commitProgress.total > 0 ? 'Subiendo imágenes al catálogo' : 'Guardando en el catálogo')}
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
          <div className="text-base font-semibold">No se pudo procesar el catálogo.</div>
          <div className="text-xs text-ink-500 mt-1 max-w-md mx-auto whitespace-pre-wrap">{error}</div>
          <button onClick={reset} className="btn-secondary mt-5">Probar otro archivo</button>
        </div>
      )}
    </>
  );
}

function CatalogDrop({ inputRef, file, onPick, onClear }) {
  return (
    <div
      className="card card-pad text-center py-16 border-2 border-dashed border-ink-200 cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition"
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onPick(e.dataTransfer.files?.[0]);
      }}
    >
      <Upload size={36} className="mx-auto text-ink-400 mb-3" />
      {!file ? (
        <>
          <div className="text-base font-medium">Suelta aquí el archivo <code className="text-[13px] px-1 py-0.5 bg-ink-100 rounded">catalog.json</code></div>
          <div className="text-sm text-ink-500 mt-1">Producido por <code className="text-[12px] px-1 py-0.5 bg-ink-100 rounded">tarif-parser</code>. Los productos y telas existentes se fusionan (no se sobreescriben).</div>
        </>
      ) : (
        <div className="flex items-center justify-center gap-3">
          <FileText size={20} className="text-emerald-600" />
          <div className="text-base font-medium">{file.name}</div>
          <button
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="btn-ghost text-xs"
            title="Quitar archivo"
          >
            <X size={14} />
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0])}
      />
    </div>
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
 * Preview row rendering the resolved hero/variant blobs from the in-memory
 * preview, so you can visually verify image matching before commit.
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
