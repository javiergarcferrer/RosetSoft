import { formatDateTime } from '../../lib/format.js';

/**
 * The display projection of a container's voyage summary — the SINGLE place
 * that turns the `voyage` object (origin/destination, vessel·voyage·carrier,
 * ETA, progress, last-update) into the strings a panel shows. Both surfaces
 * that report the same voyage — the map's glass HUD (ContainerTrackingMap's
 * VoyageHud) and the summary band beside it (ContainerTracking) — read these
 * fields instead of re-formatting the voyage themselves, so the two can never
 * drift. Pure projection: no React, no I/O.
 *
 * Two surfaces, one subtle divergence (preserved, not unified): the HUD shows
 * an `ETA …` line whenever an ETA exists — even once arrived, just without the
 * "· en N d / · vencida" tail — while the summary band suppresses ETA entirely
 * once arrived. Hence two ETA labels: `etaLabel` (the HUD form, shown whenever
 * `etaAt`) and `transitEtaLabel` (the band form, null once arrived).
 *
 * @param {import('../../lib/containerTracking.ts').VoyageSummary} voyage
 */
export function resolveVoyageHud(voyage) {
  const { origin, destination, vessel, voyage: voyageNo, carrier, etaAt, updatedAt, progressPct, arrived } = voyage;
  const meta = [vessel, voyageNo, carrier].filter(Boolean).join(' · ');
  const days = etaAt ? Math.round((etaAt - Date.now()) / 86_400_000) : null;

  // HUD form (ContainerTrackingMap › VoyageHud): the line stays once arrived,
  // shedding only the "en N d / vencida" tail.
  const etaLabel = etaAt
    ? `ETA ${formatDateTime(etaAt)}${!arrived && days != null ? (days >= 0 ? ` · en ${days} d` : ' · vencida') : ''}`
    : null;

  // Summary-band form (ContainerTracking): the whole ETA disappears once
  // arrived. `transitDays` is gated identically so the tail matches verbatim.
  const transitDays = !arrived && etaAt ? Math.round((etaAt - Date.now()) / 86_400_000) : null;
  const transitEtaLabel = !arrived && etaAt
    ? `ETA ${formatDateTime(etaAt)}${transitDays != null ? (transitDays >= 0 ? ` · en ${transitDays} d` : ' · vencida') : ''}`
    : null;

  return {
    originName: origin?.name || '—',
    destName: destination?.name || '—',
    meta,
    etaAt,
    etaLabel,
    transitEtaLabel,
    daysToEta: days,
    progressPct,
    progressLabel: arrived ? 'Entregado' : `${Math.round(progressPct)}% del trayecto`,
    arrived,
    updatedAt,
    updatedLabel: updatedAt ? `Act. ${formatDateTime(updatedAt)}` : null,
  };
}
