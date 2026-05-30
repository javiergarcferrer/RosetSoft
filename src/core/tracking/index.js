// The shipment-tracking Model + ViewModels.
//
//   • Model      — the pure logic in lib/containerTracking (ISO 6346 validation,
//                  DCSA event summarisation, route + voyage geometry), surfaced
//                  here.
//   • ViewModel  — resolveTrackableContainers (which containers to show) and the
//                  useContainerTracking hook (one container's live HL state).
//   • View       — ContainerTracking / ShipmentTracking render these; every
//                  surface (quote list, editor, client link, order) derives from
//                  the same place.
export {
  normalizeContainerNo, isValidContainerNo, validateContainerNo, detectCarrier,
  summarizeTracking, buildTrackingRoute, summarizeVoyage,
  MODE_LABELS, CLASSIFIER_LABELS,
} from '../../lib/containerTracking.js';
export { resolveTrackableContainers } from './containers.js';
export { useContainerTracking } from './useContainerTracking.js';
