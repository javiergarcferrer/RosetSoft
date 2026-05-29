import { useEffect, useMemo, useRef, useState } from 'react';
import { Ship, RefreshCw, AlertCircle, List } from 'lucide-react';
import { supabase } from '../db/supabaseClient.js';
import { formatDateTime } from '../lib/format.js';
import {
  summarizeTracking, buildTrackingRoute, summarizeVoyage, MODE_LABELS, CLASSIFIER_LABELS,
} from '../lib/containerTracking.js';
import ContainerTrackingMap from './ContainerTrackingMap.jsx';
import Dropdown, { DropdownItem } from './primitives/Dropdown.jsx';

/**
 * Hapag-Lloyd Track & Trace panel for a single container number.
 *
 * Calls the `hl-track` Edge Function (which holds the HL keys server-side and
 * runs keyless/`verify_jwt = false`, so this works the same logged-in or on the
 * public quote link) and renders the returned DCSA events as a voyage map + a
 * dropdown of every tracking point, plus the last known position and the ETA.
 * The API is BETA and only knows Hapag-Lloyd-booked containers; an empty result
 * reads as "not an HL booking", not "broken".
 *
 * Pure and self-contained — give it a normalized container number and it does
 * its own fetch — so it drops into the order, the quote editor, the quotes
 * list, and the public client link unchanged.
 */
export default function ContainerTracking({ containerNo }) {
  const [state, setState] = useState({ status: 'loading', summary: null, error: null, fetchedAt: null });

  async function load() {
    setState({ status: 'loading', summary: null, error: null, fetchedAt: null });
    try {
      const { data, error } = await supabase.functions.invoke('hl-track', {
        body: { containerNo },
      });
      if (error) {
        let msg = error.message || 'No se pudo rastrear el contenedor';
        try {
          // The function returns { error, status, detail } on upstream
          // failures; surface the cause instead of a generic message.
          const body = await error.context?.json?.();
          if (body?.error) {
            msg = body.error;
            if (body.status) msg += ` (HTTP ${body.status})`;
          }
        } catch { /* body already consumed / not JSON */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      setState({
        status: 'done',
        summary: summarizeTracking(data?.events),
        error: null,
        fetchedAt: data?.fetchedAt || null,
      });
    } catch (e) {
      setState({ status: 'error', summary: null, error: e?.message || 'Error', fetchedAt: null });
    }
  }

  useEffect(() => { load(); }, [containerNo]);

  const { status, summary, error, fetchedAt } = state;
  const mapRef = useRef(null);
  // Geocoded port hops for the map; empty when no event carries a known
  // UN/LOCODE, in which case the textual timeline below stands on its own.
  const route = useMemo(() => buildTrackingRoute(summary), [summary]);
  // High-level voyage facts for the map's HUD (endpoints, ETA, progress).
  const voyage = useMemo(() => summarizeVoyage(route, summary, containerNo), [route, summary, containerNo]);
  // Which map stop each timeline event belongs to, so clicking a row focuses
  // the matching marker. Built from the same milestone object identities.
  const milestoneStop = useMemo(() => {
    const m = new Map();
    route.stops.forEach((s, i) => (s.events || []).forEach((e) => m.set(e, i)));
    return m;
  }, [route]);

  return (
    <div className="rounded-md border border-ink-100 bg-ink-50/60 p-3 text-xs space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-ink-600">
          <Ship size={12} /> Rastreo Hapag-Lloyd
          <span className="text-[10px] font-normal text-ink-400 border border-ink-200 rounded px-1">BETA</span>
        </span>
        <button
          type="button"
          onClick={load}
          disabled={status === 'loading'}
          className="text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw size={11} className={status === 'loading' ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      {status === 'loading' && <p className="text-ink-500">Consultando Hapag-Lloyd…</p>}

      {status === 'error' && (
        <p className="text-amber-700 flex items-start gap-1.5">
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {status === 'done' && summary && summary.count === 0 && (
        <p className="text-ink-500">
          Sin eventos. Track &amp; Trace solo reporta contenedores reservados con Hapag-Lloyd.
        </p>
      )}

      {status === 'done' && summary && summary.count > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {summary.last && (
              <div className="rounded bg-white border border-ink-100 p-2">
                <div className="eyebrow text-[10px] text-ink-400">Última posición</div>
                <div className="font-medium text-ink-800">
                  {summary.last.label}{summary.last.location ? ` · ${summary.last.location}` : ''}
                </div>
                <div className="text-[10px] text-ink-500">{formatDateTime(summary.last.at)}</div>
              </div>
            )}
            {summary.eta && (
              <div className="rounded bg-white border border-ink-100 p-2">
                <div className="eyebrow text-[10px] text-ink-400">Llegada estimada</div>
                <div className="font-medium text-ink-800">{summary.eta.location || '—'}</div>
                <div className="text-[10px] text-ink-500">
                  {formatDateTime(summary.eta.at)} · {CLASSIFIER_LABELS[summary.eta.classifier] || summary.eta.classifier}
                </div>
              </div>
            )}
          </div>

          {route.stops.length > 0 && <ContainerTrackingMap ref={mapRef} route={route} voyage={voyage} />}

          {/* All tracking points live in a dropdown so the panel stays
              compact; picking one focuses its marker on the map. */}
          <Dropdown
            align="left"
            panelClassName="w-[19rem]"
            label={(
              <span className="inline-flex items-center gap-1.5">
                <List size={12} className="text-ink-500" />
                Puntos de seguimiento
                <span className="font-normal text-ink-400">· {summary.count}</span>
              </span>
            )}
          >
            {({ close }) => [...summary.milestones].reverse().map((m, i) => {
              const stopIndex = milestoneStop.get(m);
              const mappable = stopIndex != null;
              const meta = [
                m.mode ? (MODE_LABELS[m.mode] || m.mode) : null,
                m.vessel,
                m.voyage,
                CLASSIFIER_LABELS[m.classifier] || m.classifier || null,
              ].filter(Boolean).join(' · ');
              return (
                <DropdownItem
                  key={i}
                  onSelect={() => { if (mappable) mapRef.current?.focusStop(stopIndex); close(); }}
                >
                  <span className={`mt-[5px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${mappable ? 'bg-brand-500' : 'bg-ink-300'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-ink-800">
                        {m.label}
                        {m.location ? <span className="font-normal text-ink-500"> · {m.location}</span> : null}
                      </span>
                      <span className="whitespace-nowrap text-[10px] text-ink-400">{formatDateTime(m.at)}</span>
                    </span>
                    {meta && <span className="mt-0.5 block text-[10px] text-ink-400">{meta}</span>}
                  </span>
                </DropdownItem>
              );
            })}
          </Dropdown>

          {fetchedAt && (
            <p className="text-[10px] text-ink-400">Consultado {formatDateTime(Date.parse(fetchedAt))}</p>
          )}
        </>
      )}
    </div>
  );
}
