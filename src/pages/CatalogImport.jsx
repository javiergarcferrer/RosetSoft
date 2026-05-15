import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import { inspectCatalogJson, transformCatalog, commitCatalog } from '../lib/catalogImport.js';

/**
 * Catalog importer. Reads the JSON the external Python parser produces
 * (tarif-parser/out/catalog.json) and bulk-uploads it to Supabase.
 *
 * Phases:
 *   idle → reading → preview → committing → done
 *
 * "Reading" + "preview" stay in-memory; nothing touches the DB until the
 * user confirms. Commit issues bulk upserts, ~12-15 HTTP requests total
 * for a full catalog (5 tables × ~3 batches of 500).
 */
export default function CatalogImport() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const [phase, setPhase] = useState('idle');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [transformed, setTransformed] = useState(null);
  const [commitProgress, setCommitProgress] = useState({ phase: '', done: 0, total: 0, label: '' });
  const [counts, setCounts] = useState(null);

  async function onFile(file) {
    if (!file) return;
    setFileName(file.name);
    setPhase('reading');
    setError(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const insp = inspectCatalogJson(json);
      if (!insp.ok) throw new Error(insp.error);
      const t = transformCatalog(json);
      setInspection(insp);
      setTransformed(t);
      setPhase('preview');
    } catch (e) {
      console.error(e);
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  async function commit() {
    if (!transformed) return;
    setPhase('committing');
    setCommitProgress({ phase: '', done: 0, total: 0, label: '' });
    try {
      const c = await commitCatalog(transformed, {
        onProgress: (p) => setCommitProgress(p),
      });
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
    setCounts(null);
    setCommitProgress({ phase: '', done: 0, total: 0, label: '' });
  }

  return (
    <>
      <PageHeader
        title="Importar catálogo"
        subtitle="Sube el catalog.json producido por el parser Python."
      />

      {phase === 'idle' && (
        <>
          <div
            className="card card-pad text-center py-20 border-2 border-dashed border-ink-200 cursor-pointer hover:border-brand-400 hover:bg-brand-50 transition"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
          >
            <Upload size={36} className="mx-auto text-ink-400 mb-3" />
            <div className="text-base font-medium">Suelta aquí <code>catalog.json</code></div>
            <div className="text-sm text-ink-500 mt-1">
              …o haz clic para elegir el archivo. El parser Python lo genera en <code>out/catalog.json</code>.
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <div className="mt-6 inline-flex items-center gap-2 px-3 py-1.5 bg-ink-100 rounded-full text-xs text-ink-600">
              <FileText size={12} /> ~7 MB · se sube en bloques de 500 filas
            </div>
          </div>
          <div className="mt-4 card card-pad text-xs text-ink-600 leading-relaxed">
            <div className="font-medium text-ink-900 mb-1.5">Flujo</div>
            <ol className="list-decimal list-inside space-y-0.5">
              <li>Corre el parser Python (<code>build_catalog.py</code>) en tu PC contra el PDF de tarifa.</li>
              <li>Sube aquí el <code>catalog.json</code> resultante.</li>
              <li>Revisa los conteos y confirma — se suben categorías, productos, variantes y materiales en bloque.</li>
              <li>Las imágenes se importan por separado (todavía no soportado por esta página).</li>
            </ol>
          </div>
        </>
      )}

      {phase === 'reading' && (
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
                Fuente: {inspection.sourcePdf || '—'} · {inspection.pages || '?'} páginas
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

          {transformed.warnings.length > 0 && (
            <div className="card card-pad mb-4">
              <div className="text-sm font-medium text-amber-700 mb-1">
                {transformed.warnings.length} advertencias del parser
              </div>
              <div className="text-[11px] text-ink-500 max-h-32 overflow-y-auto font-mono whitespace-pre-wrap">
                {transformed.warnings.slice(0, 50).join('\n')}
                {transformed.warnings.length > 50 && `\n… y ${transformed.warnings.length - 50} más`}
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
