/**
 * Tests for src/core/jarvis/ads.js — the Ads-Manager board VM.
 *
 * Pins the multi-account aggregation the manager now does so EVERY ad shows —
 * Instagram boosts and Business Suite promotions included, even when they bill
 * through a different ad account than the one ads are created into here. The
 * load-bearing invariant is MONEY ROUTING: each account may bill in a different
 * currency, so every campaign must be formatted in ITS OWN account's currency,
 * never one board-wide currency (a wrong currency is a wrong number).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdsBoard } from '../src/core/jarvis/ads.js';

// Two accounts, different currencies: the primary (USD) plus a second account
// (DOP) that carries an Instagram boost the old single-account read would hide.
const RAW = {
  primaryAccountId: 'act_usd',
  accounts: [
    {
      id: 'act_usd', name: 'Tienda US', currency: 'USD', account_status: 1,
      amount_spent: '5000', balance: '0', spend_cap: '0',
      campaigns: [
        { id: 'c1', name: 'Verano', status: 'ACTIVE', effective_status: 'ACTIVE',
          daily_budget: '1000', insights: { data: [{ spend: '20' }] } },
      ],
    },
    {
      id: 'act_dop', name: 'Boosts DO', currency: 'DOP', account_status: 1,
      amount_spent: '120000', balance: '0', spend_cap: '0',
      campaigns: [
        { id: 'boost1', name: 'Post impulsado', status: 'ACTIVE', effective_status: 'ACTIVE',
          daily_budget: '50000', insights: { data: [{ spend: '900' }] } },
      ],
    },
  ],
};

test('resolveAdsBoard: aggregates every account; routes each currency per account', () => {
  const board = resolveAdsBoard(RAW);
  assert.equal(board.accounts.length, 2);

  const usd = board.accounts.find((a) => a.id === 'act_usd');
  const dop = board.accounts.find((a) => a.id === 'act_dop');

  // The boost on the SECOND account is present — not hidden by a single-account read.
  assert.equal(dop.campaigns[0].name, 'Post impulsado');

  // Money is routed per account: USD budget 1000c → $10; DOP budget 50000c → 500.
  assert.equal(usd.campaigns[0].currency, 'USD');
  assert.equal(usd.campaigns[0].dailyBudget, 10);
  assert.equal(dop.campaigns[0].currency, 'DOP');
  assert.equal(dop.campaigns[0].dailyBudget, 500);

  // Account financials convert in their own currency too (minor → major).
  assert.equal(usd.amountSpent, 50);     // 5000 cents
  assert.equal(dop.amountSpent, 1200);   // 120000 cents
});

test('resolveAdsBoard: primary leads and feeds the wizard currency', () => {
  const board = resolveAdsBoard(RAW);
  assert.equal(board.accounts[0].id, 'act_usd'); // primary first
  assert.equal(board.account.id, 'act_usd');     // create-wizard account
  assert.equal(board.currency, 'USD');           // create-wizard currency
});

test('resolveAdsBoard: flat campaigns roll up across accounts, spend-ranked', () => {
  const board = resolveAdsBoard(RAW);
  assert.equal(board.campaigns.length, 2);
  // The DOP boost (spend 900) outranks the USD campaign (spend 20) regardless
  // of which account it lives in — the flat list is the at-a-glance roll-up.
  assert.equal(board.campaigns[0].id, 'boost1');
  assert.equal(board.campaigns[1].id, 'c1');
});

test('resolveAdsBoard: falls back to the legacy single-account payload', () => {
  // A brief deploy skew (old edge function ↔ new client) still renders.
  const legacy = {
    account: { id: 'act_x', name: 'Legacy', currency: 'USD', amount_spent: '0', account_status: 1 },
    currency: 'USD',
    campaigns: [{ id: 'lc', name: 'Old', status: 'ACTIVE', effective_status: 'ACTIVE', insights: { data: [{ spend: '5' }] } }],
  };
  const board = resolveAdsBoard(legacy);
  assert.equal(board.accounts.length, 1);
  assert.equal(board.account.id, 'act_x');
  assert.equal(board.currency, 'USD');
  assert.equal(board.campaigns[0].id, 'lc');
  assert.equal(board.campaigns[0].currency, 'USD');
});
