import { useRef } from 'react';
import { Ship, RefreshCw, AlertCircle, List, ArrowRight, CheckCircle2, Navigation, MapPin } from 'lucide-react';
import { formatDateTime } from '../lib/format.js';
import { MODE_LABELS, CLASSIFIER_LABELS } from '../lib/containerTracking.js';
import { useContainerTracking } from '../core/tracking/useContainerTracking.js';
import { resolveVoyageHud } from '../core/tracking/voyage.js';
import ContainerTrackingMap from './ContainerTrackingMap.jsx';
import Dropdown, { DropdownItem } from './primitives/Dropdown.jsx';

/**
 * Hapag-Lloyd Track & Trace panel for a single container number.
 *
 * Calls the `hl-track` Edge Function (which holds the HL keys server-side and
 * runs keyless/`verify_jwt = false`) and renders the returned DCSA events as a
 * voyage map + a dropdown of every tracking point, plus the last known position
 * and the ETA. The API is BETA and only knows Hapag-Lloyd-booked containers; an
 * empty result reads as "not an HL booking", not "broken".
 *
 * Pure and self-contained — give it a normalized container number and it does
 * its own fetch — so it drops into the order, the quote editor, the quotes
 * list, and the public client link unchanged. On the public link (logged-OUT)
 * pass `shareToken`: the function authorizes either a dealer's session OR a
 * share token bound to the container's order, so tracking works the same in the
 * app and on the public link — without it the keyless call reads as an expired
 * session.
 */
export default function ContainerTracking({ containerNo, shareToken, arrivalAction = null }) {
  // ViewModel — owns the hl-track fetch + the summary → route → voyage
  // derivation; this view renders it and derives nothing itself.
  const { status, summary, error, fetchedAt, route, voyage, milestoneStop, reload } =
    useContainerTracking(containerNo, shareToken);
  const mapRef = useRef(null);

  // Same voyage projection the map's HUD reads; `transitEtaLabel` is the band
  // form (suppressed once arrived — see resolveVoyageHud).
  const { meta, transitEtaLabel: etaLabel, progressLabel } = resolveVoyageHud(voyage);

  return (
    <div className="vtrack surface-subtle p-3 text-xs space-y-3 min-w-0 w-full">
      <div className="flex items-center justify-between gap-2 flex-wrap min-w-0">
        <span className="flex items-center gap-1.5 font-medium text-ink-600">
          <Ship size={12} aria-hidden /> Rastreo Hapag-Lloyd
          <span className="chip text-ink-400 border border-ink-200">BETA</span>
        </span>
        <button
          type="button"
          onClick={reload}
          disabled={status === 'loading'}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 min-h-7 coarse:min-h-11 text-ink-500 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={11} className={status === 'loading' ? 'animate-spin' : ''} aria-hidden /> Actualizar
        </button>
      </div>

      {status === 'loading' && <p role="status" aria-live="polite" className="text-ink-500">Consultando Hapag-Lloyd…</p>}

      {status === 'error' && (
        <p role="alert" className="text-amber-700 flex items-start gap-1.5">
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      {status === 'done' && summary && summary.count === 0 && (
        <p className="text-ink-500">
          Sin eventos. Track &amp; Trace solo reporta contenedores reservados con Hapag-Lloyd.
        </p>
      )}

      {status === 'done' && summary && summary.count > 0 && (
        <div className={route.stops.length > 0 ? 'vtrack-grid' : 'space-y-3'}>
          {/* Voyage summary — route, status, progress and last position in one
              clean band. On wide panels the map sits beside it (see .vtrack-grid);
              the map's overlay HUD only appears when expanded to full screen. */}
          <div className="vtrack-summary rounded-lg border border-ink-100 bg-surface p-2.5 space-y-2 min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap min-w-0">
              {/* Port names wrap, never truncate — they're the client's data. */}
              {voyage.origin ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold text-ink-900">
                  <span className="min-w-0 break-words">{voyage.origin.name}</span>
                  <ArrowRight size={13} className="shrink-0 text-ink-300" aria-hidden />
                  <span className="min-w-0 break-words">{voyage.destination?.name || '—'}</span>
                </div>
              ) : (
                <span className="font-semibold text-ink-900 min-w-0 break-words">Seguimiento del contenedor</span>
              )}
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${voyage.arrived ? 'bg-emerald-50 text-emerald-700' : 'bg-brand-50 text-brand-700'}`}>
                {voyage.arrived ? <CheckCircle2 size={11} /> : <Navigation size={11} />}
                {voyage.arrived ? 'Entregado' : 'En tránsito'}
              </span>
            </div>

            {meta && <div className="break-words text-[11px] text-ink-500">{meta}</div>}

            {voyage.totalKm > 0 && (
              <div className="space-y-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-ink-100">
                  <div
                    className={`h-full rounded-full ${voyage.arrived ? 'bg-emerald-500' : 'bg-brand-500'}`}
                    style={{ width: `${Math.max(3, Math.round(voyage.progressPct))}%` }}
                  />
                </div>
                <div className="flex items-baseline justify-between gap-2 text-[10px] text-ink-500">
                  <span className="font-medium">{progressLabel}</span>
                  {etaLabel && <span className="min-w-0 text-right break-words">{etaLabel}</span>}
                </div>
              </div>
            )}

            {summary.last && (
              <div className="flex items-start gap-1.5 border-t border-ink-100 pt-2 text-[11px] text-ink-600">
                <MapPin size={12} className="mt-0.5 shrink-0 text-ink-400" />
                <span className="min-w-0">
                  <span className="font-medium text-ink-800">{summary.last.label}</span>
                  {summary.last.location ? ` · ${summary.last.location}` : ''}
                  <span className="text-ink-400"> · {formatDateTime(summary.last.at)}</span>
                </span>
              </div>
            )}

            {/* Workflow nudge slot — the host surface (OrderDetail) supplies an
                action that's only meaningful once the carrier reports arrival;
                the human still confirms, nothing auto-advances. */}
            {voyage.arrived && arrivalAction}
          </div>

          {route.stops.length > 0 && (
            <div className="vtrack-map">
              <ContainerTrackingMap ref={mapRef} route={route} voyage={voyage} />
            </div>
          )}

          {/* Tracking points + the "consultado" stamp share the left column on
              wide panels; a dropdown keeps the list compact. */}
          <div className="vtrack-points space-y-2">
          <Dropdown
            align="left"
            panelClassName="w-[min(20rem,calc(100vw-1.5rem))]"
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
          </div>
        </div>
      )}
    </div>
  );
}
