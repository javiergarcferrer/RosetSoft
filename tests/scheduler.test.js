/**
 * Tests for src/core/jarvis/scheduler.js — the IG scheduling VM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScheduleAgenda, describePost, resolveCatalogProducts } from '../src/core/jarvis/scheduler.js';

const NOW = Date.parse('2026-06-14T12:00:00Z');
const DAY = 86_400_000;

test('agenda splits pending (soonest first) from history (newest first)', () => {
  const rows = [
    { id: 'a', status: 'queued', scheduledAt: NOW + 2 * DAY, kind: 'Reel', preview: 'x' },
    { id: 'b', status: 'queued', scheduledAt: NOW + 1 * DAY },
    { id: 'c', status: 'published', scheduledAt: NOW - 1 * DAY },
    { id: 'd', status: 'failed', scheduledAt: NOW - 2 * DAY, lastError: 'boom' },
    { id: 'e', status: 'publishing', scheduledAt: NOW + 3 * DAY },
  ];
  const { upcoming, recent, nextAt } = resolveScheduleAgenda(rows, { now: NOW });
  assert.deepEqual(upcoming.map((i) => i.id), ['b', 'a', 'e']); // pending, soonest first
  assert.equal(nextAt, NOW + 1 * DAY);
  assert.deepEqual(recent.map((i) => i.id), ['c', 'd']); // history, newest first
  assert.equal(recent.find((i) => i.id === 'd').error, 'boom');
  assert.equal(upcoming[0].statusLabel, 'Programado');
});

test('describePost picks the post kind + caption preview', () => {
  assert.equal(describePost({ igStory: true }).kind, 'Story');
  assert.equal(describePost({ carousel: [{}, {}] }).kind, 'Carrusel');
  assert.equal(describePost({ videoUrl: 'v.mp4' }).kind, 'Reel');
  assert.equal(describePost({ imageUrl: 'i.jpg' }).kind, 'Feed');
  assert.equal(describePost({ message: '  hola   mundo ' }).preview, 'hola mundo');
});

test('catalog products normalize the search payload, dropping rows with no id', () => {
  const rows = resolveCatalogProducts({
    products: [
      { product_id: '111', product_name: 'Togo', retailer_id: 'SKU1', image_url: 'u', review_status: 'approved' },
      { product_name: 'no id' },
    ],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { id: '111', name: 'Togo', retailerId: 'SKU1', image: 'u', reviewStatus: 'approved' });
});
