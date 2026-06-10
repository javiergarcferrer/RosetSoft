// The shipment-tracking Model + ViewModels.
//
//   • Model      — the pure logic in lib/containerTracking (ISO 6346 validation,
//                  DCSA event summarisation, route + voyage geometry), surfaced
//                  here.
//   • ViewModel  — resolveTrackableContainers (which containers to show),
//                  resolveVoyageHud (the voyage summary fields the map HUD and
//                  the summary band share), and the useContainerTracking hook
//                  (one container's live HL state).
//   • View       — ContainerTracking / ShipmentTracking render these; every
//                  surface (quote list, editor, client link, order) derives from
//                  the same place.
export {
  normalizeContainerNo, isValidContainerNo, validateContainerNo, detectCarrier,
  summarizeTracking, buildTrackingRoute, summarizeVoyage,
  MODE_LABELS, CLASSIFIER_LABELS,
} from '../../lib/containerTracking.js';
export { resolveTrackableContainers } from './containers.js';
export { resolveVoyageHud } from './voyage.js';
export { useContainerTracking, useContainerEtas } from './useContainerTracking.js';
