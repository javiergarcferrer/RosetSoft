import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, CheckCircle2, AlertCircle, FileJson, FileType } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { inspectCatalogJson, transformCatalog, commitCatalog } from '../lib/catalogImport.js';
import { buildCatalogFromPdf } from '../parser/buildCatalog.js';

/**
 * Catalog importer with two upload paths:
 *
 *   1. PDF  — parse the tariff in the browser (PDF.js), produce the same
 *             JSON the Python parser does, then run the upload pipeline.
 *   2. JSON — bring a pre-built `catalog.json` (e.g. from the Python pipeline)
 *             and skip parsing.
 *
 * Both paths converge on the same `commitCatalog()` call: five bulk-upsert
 * phases (categories → products → product_variants → materials → colors)
 * with retry-on-error.
 */
export default function CatalogImport() {
  const navigate = useNavigate();
  const pdfInputRef = useRef(null);
  const jsonInputRef = useRef(null);

  const [phase, setPhase] = useState('idle');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState(null);
  const [parseProgress, setParseProgress] = useState({ phase: '', page: 0, total: 0, label: '' });
  const [inspection, setInspection] = useState(null);
  const [transformed, setTransformed] = useState(null);
  const [parserWarnings, setParserWarnings] = useState([]);
  const [commitProgress, setCommitProgress] = useState({ phase: '', done: 0, total: 0, label: '' });
  const [counts, setCounts] = useState(null);

  async function onPdfFile(file) {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setPhase('parsing-pdf');
    setParseProgress({ phase: 'toc', page: 0, total: 0, label: 'Leyendo índice' });
    try {
      const { json, warnings } = await buildCatalogFromPdf(file, {
        sourceName: file.name,
        onProgress: setParseProgress,
      });
      setParserWarnings(warnings);
      await ingestJson(json);
    } catch (e) {
      console.error(e);
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function onJsonFile(file) {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setPhase('reading-json');
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      await ingestJson(json);
    } catch (e) {
      console.error(e);
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function ingestJson(json) {
    const insp = inspectCatalogJson(json);
    if (!insp.ok) throw new Error(insp.error);
    const t = transformCatalog(json);
    setInspection(insp);
    setTransformed(t);
    setPhase('preview');
  }

  async function commit() {
    if (!transformed) return;
    setPhase('committing');
    setCommitProgress({ phase: '', done: 0, total: 0, label: '' });
    try {
      const c = await commitCatalog(transformed, { onProgress: setCommitProgress });
      setCounts(c);
      setPhase('done');
    } catch (e) {
      console.error(e);
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  function reset() {
    setPhase('idle');
    setFileName('');
    setError(null);
    setInspection(null);
    setTransformed(null);
    setParserWarnings([]);
    setCounts(null);
    setCommitProgress({ phase: '', done: 0, total: 0, label: '' });
    setParseProgress({ phase: '', page: 0, total: 0, label: '' });
  }

  return (
    <>
      <PageHeader
        title="Importar catálogo"
        subtitle="Sube el PDF de tarifa Ligne Roset (USA) — el parser corre en tu navegador."
      />

      {phase === 'idle' && (
        <div className="grid md:grid-cols-2 gap-4">
          <div
            className="card card-pad text-center py-16 border-2 border-dashed border-ink-200 cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition"
            onClick={() => pdfInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onPdfFile(e.dataTransfer.files?.[0]); }}
          >
            <FileType size={32} className="mx-auto text-ink-400 mb-3" />
            <div className="text-base font-medium">Subir PDF de tarifa</div>
            <div className="text-sm text-ink-500 mt-1">
              Suelta aquí <code>TARIF.pdf</code> · ~100 MB · parseo ~60–120 s
            </div>
            <input
              ref={pdfInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => onPdfFile(e.target.files?.[0])}
            />
          </div>

          <div
            className="card card-pad text-center py-16 border-2 border-dashed border-ink-200 cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition"
            onClick={() => jsonInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onJsonFile(e.dataTransfer.files?.[0]); }}
          >
            <FileJson size={32} className="mx-auto text-ink-400 mb-3" />
            <div className="text-base font-medium">Subir catalog.json</div>
            <div className="text-sm text-ink-500 mt-1">
              Si ya tienes el JSON precomputado del parser Python
            </div>
            <input
              ref={jsonInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => onJsonFile(e.target.files?.[0])}
            />
          </div>

          <div className="md:col-span-2 card card-pad text-xs text-ink-600 leading-relaxed">
            <div className="font-medium text-ink-900 mb-1.5">Flujo</div>
            <ol className="list-decimal list-inside space-y-0.5">
              <li>Sube el PDF — todo el parseo ocurre en el navegador.</li>
              <li>Revisa la vista previa (categorías, productos, variantes, materiales).</li>
              <li>Confirma — se sube a Supabase en bloques de 500 filas con reintentos.</li>
            </ol>
            <div className="mt-2 text-ink-500">
              Las imágenes vectoriales/raster del PDF no se importan todavía. Se pueden subir manualmente por producto desde el catálogo.
            </div>
          </div>
        </div>
      )}

      {phase === 'parsing-pdf' && (
        <div className="card card-pad text-center py-16">
          <div className="text-sm text-ink-500 mb-2">{parseProgress.label || 'Parseando PDF…'}</div>
          {parseProgress.total > 0 ? (
            <>
              <div className="text-2xl font-semibold tabular-nums">
                {parseProgress.page} / {parseProgress.total}
              </div>
              <div className="w-full max-w-md mx-auto mt-4 h-1.5 bg-ink-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 transition-all"
                  style={{ width: `${(parseProgress.page / parseProgress.total) * 100}%` }}
                />
              </div>
            </>
          ) : (
            <div className="text-[11px] text-ink-500">Cargando documento…</div>
          )}
          <div className="text-[11px] text-ink-500 mt-3">
            Fase: <span className="font-mono">{parseProgress.phase || '—'}</span>
          </div>
        </div>
      )}

      {phase === 'reading-json' && (
        <div className="card card-pad text-center py-16">
          <div className="text-sm text-ink-500">Leyendo {fileName}…</div>
        </div>
      )}

      {phase === 'preview' && inspection && transformed && (
        <>
          <div className="card card-pad mb-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="text-sm font-medium">{fileName}</div>
              <div className="text-xs text-ink-500">
                {inspection.sourcePdf ? `Fuente: ${inspection.sourcePdf} · ` : ''}{inspection.pages || '?'} páginas
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={reset} className="btn-ghost">Cancelar</button>
              <button onClick={commit} className="btn-primary">Guardar en Supabase</button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <Stat label="Categorías" value={transformed.categories.length} />
            <Stat label="Productos"  value={transformed.products.length} />
            <Stat label="Variantes"  value={transformed.variants.length} />
            <Stat label="Materiales" value={transformed.materials.length} />
            <Stat label="Colores"    value={transformed.materialColors.length} />
          </div>

          {(transformed.warnings.length > 0 || parserWarnings.length > 0) && (
            <div className="card card-pad mb-4">
              <div className="text-sm font-medium text-amber-700 mb-1">
                {parserWarnings.length + transformed.warnings.length} advertencias
              </div>
              <div className="text-[11px] text-ink-500 max-h-32 overflow-y-auto font-mono whitespace-pre-wrap">
                {[...parserWarnings, ...transformed.warnings].slice(0, 50).join('\n')}
                {parserWarnings.length + transformed.warnings.length > 50 &&
                  `\n… y ${parserWarnings.length + transformed.warnings.length - 50} más`}
              </div>
            </div>
          )}

          <div className="card overflow-hidden">
            <table className="table">
              <thead><tr><th>Categoría</th><th className="text-right">Productos</th></tr></thead>
              <tbody>
                {transformed.categories.map((c) => {
                  const n = transformed.products.filter((p) => p.categoryId === c.id).length;
                  return (
                    <tr key={c.id}>
                      <td className="font-medium">{c.name}</td>
                      <td className="text-right text-ink-600">{n}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
            Bloques de 500 filas, con reintentos automáticos.
          </div>
        </div>
      )}

      {phase === 'done' && counts && (
        <div className="card card-pad text-center py-16">
          <CheckCircle2 size={36} className="mx-auto text-emerald-500 mb-3" />
          <div className="text-base font-semibold">Catálogo importado.</div>
          <div className="text-sm text-ink-500 mt-1">
            {counts.categories} categorías · {counts.products} productos · {counts.variants} variantes ·{' '}
            {counts.materials} materiales · {counts.colors} colores
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
          <button onClick={reset} className="btn-secondary mt-5">Volver a intentar</button>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }) {
  return (
    <div className="card card-pad">
      <div className="text-[10px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value.toLocaleString('en-US')}</div>
    </div>
  );
}
