import { useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox, MessageCircle, Mail, ArrowRight, Trash2, Loader2, FileDown } from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../db/database.js';
import { formatMoney, formatDateTime } from '../lib/format.js';
import { downloadText } from '../lib/csv.js';
import { LINE_KIND_ITEM } from '../lib/constants.js';
import { productForGrade } from '../lib/catalog.js';
import { composeSubtype } from '../lib/subtype.js';
import { swatchUrl } from '../lib/swatchImage.js';
import {
  effectiveRates, initialQuoteTerms,
  resolveConfigurator, resolveTogoModels, buildTogoModularSeed,
  resolveTogoDxf, placementsFromPlaced,
} from '../core/quote/index.js';
import EmptyState from '../components/EmptyState.jsx';
import { useMeshPlans, applyMeshPlans } from '../components/togo/useMeshPlans.js';

// A small read-only render of the visitor's plan (cm → px at THUMB_SCALE).
const THUMB_SCALE = 0.3;

/**
 * The "Solicitudes" tab of the Togo workspace — the inbox of web leads captured
 * by the public configurator widget (`togo_requests`, status `pending`). Each
 * request shows the visitor's contact + a thumbnail of the plan they built and
 * the estimate they saw. The dealer triages here and PROMOTES the ones they want
 * into the regular pipeline ("Pasar a cotización" → a draft quote, replaying the
 * placements through the SAME configurator engine the internal builder uses), or
 * dismisses the rest. Nothing reaches Cotizaciones until the dealer says so.
 */
export default function TogoRequests() {
  const navigate = useNavigate();
  const { profileId, settings, currentProfile } = useApp();

  const requests = useLiveQuery(
    () => (profileId
      ? db.togoRequests.where('profileId').equals(profileId).toArray()
      : Promise.resolve([])),
    [profileId], [],
  );
  const models = useLiveQuery(
    () => (profileId ? db.togoModels.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );
  const products = useLiveQuery(
    () => (profileId ? db.products.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId], [],
  );

  const base = useMemo(() => resolveTogoModels(models, products), [models, products]);
  const families = base.families;
  // Same FBX-derived plan the customer built with (the embed), so the dealer's
  // preview, totals and manufacturing DXF match the mesh — not the stale DWG plan.
  const meshEntries = useMemo(() => models.map((m) => ({ id: m.id, url: m.meshUrl, upAxis: m.meshUpAxis })), [models]);
  const meshPlans = useMeshPlans(meshEntries);
  const { svgById, resolvedById } = useMemo(
    () => applyMeshPlans(meshPlans, base.svgById, base.resolvedById),
    [meshPlans, base],
  );
  const rates = useMemo(() => effectiveRates(settings), [settings]);

  const pending = useMemo(
    () => (requests || [])
      .filter((r) => r.status === 'pending')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [requests],
  );

  const [busyId, setBusyId] = useState(null);

  // Promote a request into the regular quote pipeline — a draft quote whose only
  // line is the modular Togo configuration, exactly as the internal builder makes.
  const promote = useCallback(async (req) => {
    if (busyId) return;
    setBusyId(req.id);
    try {
      // Replay the placements — carrying the visitor's fabric pick, repriced by
      // grade against the DEALER's catalog (list price; the quote's margin applies
      // on top), exactly as the internal editor would.
      const placed = (req.items || []).map((it) => {
        const base = { uid: newId(), pieceId: it.modelId, x: it.x, y: it.y, rot: it.rot };
        const mat = it.material;
        if (mat && (mat.grade || mat.fabric)) {
          const fam = families.get(resolvedById[it.modelId]?.root);
          const p = fam ? productForGrade(fam, mat.grade) : null;
          base.material = {
            grade: mat.grade || '', fabric: mat.fabric || '', code: mat.code || '', swatchImageId: null,
            subtype: composeSubtype(mat.grade, mat.fabric),
            reference: p?.reference || '',
            unitPrice: p && p.priceUsd != null ? Number(p.priceUsd) : (resolvedById[it.modelId]?.unitPrice ?? null),
          };
        }
        return base;
      });
      const id = newId();
      const c = req.contact || {};
      const notes = [
        'Solicitud web (configurador Togo)',
        c.name ? `Nombre: ${c.name}` : '',
        c.phone ? `Teléfono: ${c.phone}` : '',
        c.email ? `Correo: ${c.email}` : '',
        req.note ? `Nota: ${req.note}` : '',
      ].filter(Boolean).join('\n');
      const defaults = {
        id, profileId, createdByUserId: currentProfile?.id || null, number: null,
        customerId: null, professionalId: null, commissionPct: null,
        orderType: 'floor', orderId: null, status: 'draft', currencyCode: 'USD',
        rates: effectiveRates(settings),
        marginPct: settings?.defaultMarginPct || 0, discountPct: settings?.defaultDiscountPct || 0,
        shipping: 0, terms: initialQuoteTerms(settings, 'floor'), notes,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      await assignSequenceNumber({
        table: 'quotes', profileId, start: 1001,
        build: (number) => ({ ...defaults, number, updatedAt: Date.now() }),
      });
      const seed = buildTogoModularSeed(placed, resolvedById, newId);
      await db.quoteLines.put({
        id: newId(), quoteId: id, kind: LINE_KIND_ITEM, sortOrder: 0,
        family: seed.family, reference: '', name: seed.name, subtype: '',
        dimensions: '', description: '', productDescription: '', pageRef: '',
        imageId: null, qty: 1, unitPrice: 0, unitCost: null,
        lineMarginPct: 0, lineDiscountPct: 0, priceMin: null, priceMax: null,
        notes: '', components: seed.components,
        isOptional: false, optionalOffered: false, materialOptions: null,
      });
      await db.togoRequests.update(req.id, { status: 'converted', quoteId: id, updatedAt: Date.now() });
      navigate(`/quotes/${id}`);
    } catch (e) {
      console.error('[togo] could not promote request', e);
      setBusyId(null);
    }
  }, [busyId, profileId, currentProfile, settings, families, resolvedById, navigate]);

  const dismiss = useCallback(async (req) => {
    await db.togoRequests.update(req.id, { status: 'dismissed', updatedAt: Date.now() });
  }, []);

  if (!pending.length) {
    return (
      <EmptyState
        icon={Inbox}
        title="Sin solicitudes nuevas"
        description="Las solicitudes que los clientes envíen desde el configurador embebido en tu web aparecerán aquí para que las revises antes de pasarlas a cotización."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-500">
        {pending.length} solicitud{pending.length === 1 ? '' : 'es'} pendiente{pending.length === 1 ? '' : 's'} ·
        revisa cada diseño y pásalo a cotización cuando quieras darle seguimiento.
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {pending.map((req) => (
          <RequestCard
            key={req.id}
            req={req}
            rates={rates}
            resolvedById={resolvedById}
            svgById={svgById}
            busy={busyId === req.id}
            onPromote={() => promote(req)}
            onDismiss={() => dismiss(req)}
          />
        ))}
      </div>
    </div>
  );
}

function RequestCard({ req, rates, resolvedById, svgById, busy, onPromote, onDismiss }) {
  const c = req.contact || {};
  const placed = useMemo(
    () => (req.items || []).map((it, i) => ({ uid: `${req.id}-${i}`, pieceId: it.modelId, x: it.x, y: it.y, rot: it.rot })),
    [req],
  );
  const vm = useMemo(() => resolveConfigurator(placed, resolvedById, { scale: THUMB_SCALE }), [placed, resolvedById]);
  const phoneDigits = (c.phone || '').replace(/\D/g, '');

  // Download the visitor's layout as a CAD plan (DXF) — the inverse of the
  // DWG→SVG model import: the placed pieces handed back OUT as drawing geometry
  // (real cm, layered, the actual Togo outlines) an architect drops into AutoCAD.
  const downloadDxf = useCallback(() => {
    const placements = placementsFromPlaced(placed, resolvedById, svgById);
    const { dxf, filename } = resolveTogoDxf(placements, { name: c.name || 'solicitud' });
    downloadText(filename, dxf);
  }, [placed, resolvedById, svgById, c.name]);
  // Distinct fabrics the visitor chose, with swatches.
  const fabrics = useMemo(() => {
    const seen = new Map();
    for (const it of (req.items || [])) {
      const m = it.material;
      if (m?.fabric && !seen.has(m.fabric)) seen.set(m.fabric, m.code || '');
    }
    return [...seen.entries()].map(([fabric, code]) => ({ fabric, code }));
  }, [req]);

  return (
    <div className="card card-pad space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display font-semibold text-sm truncate">{c.name || 'Sin nombre'}</div>
          <div className="text-[11px] text-ink-500">{formatDateTime(req.createdAt)}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-ink-500 uppercase tracking-wide">Estimado</div>
          <div className="text-sm font-semibold tabular-nums">{formatMoney(req.estimateUsd || 0, 'DOP', rates)}</div>
          <div className="text-[11px] text-ink-500 tabular-nums">{vm.count} pieza{vm.count === 1 ? '' : 's'}</div>
          {vm.count > 0 && vm.overallCm.widthCm > 0 && (
            <div className="text-[10px] text-ink-400 tabular-nums">{vm.overallCm.widthCm}×{vm.overallCm.depthCm} cm</div>
          )}
        </div>
      </div>

      {/* Contact chips. */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {c.phone && (
          <a href={`https://wa.me/${phoneDigits}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2.5 py-1 hover:bg-ink-50">
            <MessageCircle size={13} className="text-emerald-600" /> {c.phone}
          </a>
        )}
        {c.email && (
          <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2.5 py-1 hover:bg-ink-50">
            <Mail size={13} className="text-ink-500" /> <span className="truncate max-w-[160px]">{c.email}</span>
          </a>
        )}
      </div>

      {/* The plan the visitor built — read-only thumbnail. */}
      {vm.count > 0 && (
        <div className="rounded-lg border border-ink-200 bg-ink-50/40 overflow-auto">
          <div className="relative mx-auto" style={{ width: vm.canvas.wPx, height: vm.canvas.hPx }}>
            {vm.tiles.map((t) => (
              <div key={t.uid} className="absolute" style={{ left: t.leftPx, top: t.topPx, width: t.wPx, height: t.hPx }}>
                <div
                  className="absolute top-1/2 left-1/2 text-ink-700"
                  style={{ width: t.innerWPx, height: t.innerHPx, transform: `translate(-50%, -50%) rotate(${t.rot}deg)` }}
                  dangerouslySetInnerHTML={{ __html: svgById[t.pieceId] || '' }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {fabrics.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {fabrics.map((f) => (
            <span key={f.fabric} className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2 py-0.5 text-[11px]">
              {f.code && <img src={swatchUrl(f.code)} alt="" className="w-3 h-3 rounded-sm object-cover" />}
              <span className="truncate max-w-[180px]">{f.fabric}</span>
            </span>
          ))}
        </div>
      )}

      {req.note && <p className="text-[12px] text-ink-600 bg-ink-50 rounded-md px-2.5 py-1.5 whitespace-pre-wrap">{req.note}</p>}

      <div className="flex items-center justify-between gap-1.5 pt-0.5">
        {vm.count > 0 ? (
          <button type="button" onClick={downloadDxf} className="btn-ghost text-xs text-ink-600" title="Descargar el plano en CAD (DXF) — se abre en AutoCAD y cualquier programa de planos">
            <FileDown size={14} /> Plano DXF
          </button>
        ) : <span />}
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onDismiss} disabled={busy} className="btn-ghost text-xs text-ink-500 disabled:opacity-40">
            <Trash2 size={14} /> Descartar
          </button>
          <button type="button" onClick={onPromote} disabled={busy} className="btn-primary text-xs disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />} Pasar a cotización
          </button>
        </div>
      </div>
    </div>
  );
}
