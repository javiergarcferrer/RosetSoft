/**
 * Instagram scheduler ViewModel — pure projections over the `scheduled_posts`
 * queue and the Shopping `catalog_product_search` payload. The View writes/reads
 * the rows via db; these turn them into the agenda the calendar renders and the
 * product list the tag picker shows.
 */

const STATUS_LABEL = {
  queued: 'Programado',
  publishing: 'Publicando…',
  published: 'Publicado',
  failed: 'Falló',
  canceled: 'Cancelado',
};

/** First displayable image in a queued publish payload (null for video-only). */
function payloadThumb(payload) {
  if (!payload) return null;
  if (payload.imageUrl) return payload.imageUrl;
  const item = (payload.carousel || []).find((c) => c?.imageUrl);
  return item?.imageUrl || null;
}

/**
 * Split the queue into an upcoming agenda (soonest first) and recent history
 * (newest first). `kind`/`preview`/`error` ride along for the calendar cell.
 */
export function resolveScheduleAgenda(rows, { now = Date.now() } = {}) {
  const items = (rows || []).map((r) => ({
    id: r.id,
    at: r.scheduledAt || 0,
    status: r.status || 'queued',
    statusLabel: STATUS_LABEL[r.status] || r.status || '',
    kind: r.kind || 'Publicación',
    preview: r.preview || '',
    // A thumbnail for the post-peek popup, pulled from the queued payload (a
    // single feed/story image, or the first image of a carousel).
    thumb: payloadThumb(r.payload),
    error: r.lastError || null,
    pending: r.status === 'queued' || r.status === 'publishing',
  }));
  const upcoming = items.filter((i) => i.pending).sort((a, b) => a.at - b.at);
  const recent = items.filter((i) => !i.pending).sort((a, b) => b.at - a.at).slice(0, 20);
  return { upcoming, recent, nextAt: upcoming[0]?.at || null };
}

/** A short, human label for a scheduled post (drives `kind` + `preview`). */
export function describePost(payload) {
  const mode = payload?.igStory ? 'Story'
    : payload?.carousel?.length ? 'Carrusel'
      : payload?.videoUrl ? 'Reel'
        : 'Feed';
  const preview = String(payload?.message || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { kind: mode, preview };
}

/** catalog_product_search payload → the tag picker's product rows. */
export function resolveCatalogProducts(payload) {
  return (payload?.products || [])
    .map((p) => ({
      id: String(p.product_id || ''),
      name: String(p.product_name || p.name || 'Producto'),
      retailerId: p.retailer_id ? String(p.retailer_id) : '',
      image: p.image_url || null,
      reviewStatus: p.review_status || '',
    }))
    .filter((p) => p.id);
}
