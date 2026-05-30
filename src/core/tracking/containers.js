import { isValidContainerNo } from '../../lib/containerTracking.js';

/**
 * The trackable subset of a container list — those carrying a valid ISO 6346
 * code. The SINGLE decision for "which containers can we track", shared by every
 * surface that lists shipment tracking (the quote list, the editor, the client
 * link) so the predicate is never re-implemented per view.
 */
export function resolveTrackableContainers(containers) {
  return (containers || []).filter((c) => isValidContainerNo(c?.code));
}
