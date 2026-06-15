// ViewModel for WhatsApp RECEPTION HEALTH — "am I missing inbound messages?".
//
// wa-webhook logs every VERIFIED delivery to wa_webhook_events and only flips
// `processed` true once the batch is stored; a row left unprocessed (carrying a
// `processError`) is a delivery that FAILED to persist — Meta is redelivering it
// (the webhook answers 5xx on a store failure). This VM rolls those failures
// plus the last inbound timestamp into one status the Configuración panel shows.
//
// Limitation by design: a delivery that never REACHES the webhook (wrong App
// Secret, or the `messages` field not subscribed in Meta) leaves nothing to
// count, so it reads 'ok' here. That gap is covered by the on-demand reception
// self-test (send a real message and watch the inbound count rise) and by Meta's
// own webhook-delivery dashboard.
//
// Pure projection — no React, no db, no supabase.

const HOUR_MS = 3_600_000;

/**
 * resolveWaHealth({ failedEvents, lastInboundAt, now })
 *   → { status, failedCount, errorSample, oldestFailedAt, lastInboundAt, hoursSinceInbound }
 *
 * `status` is 'down' when any verified delivery failed to store (a concrete
 * "messages may be missing" signal), else 'ok'. `failedEvents` are the
 * unprocessed `wa_webhook_events` rows (camelCase via rowMapping); `errorSample`
 * is the first row's `processError` (null when none carries one); `oldestFailedAt`
 * is the earliest `receivedAt` among them.
 */
export function resolveWaHealth({ failedEvents = [], lastInboundAt = null, now = Date.now() } = {}) {
  const failed = Array.isArray(failedEvents) ? failedEvents.filter(Boolean) : [];
  const withError = failed.filter((e) => e.processError);
  const oldestFailedAt = failed.reduce(
    (min, e) => (e.receivedAt != null && e.receivedAt < min ? e.receivedAt : min),
    Infinity,
  );
  return {
    status: failed.length > 0 ? 'down' : 'ok',
    failedCount: failed.length,
    errorSample: withError[0]?.processError || null,
    oldestFailedAt: Number.isFinite(oldestFailedAt) ? oldestFailedAt : null,
    lastInboundAt: lastInboundAt ?? null,
    hoursSinceInbound: lastInboundAt != null ? Math.floor((now - lastInboundAt) / HOUR_MS) : null,
  };
}
