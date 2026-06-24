/**
 * Tests for the Spanish amount-in-words (src/lib/numeroEnLetras.js) printed as
 * "Son: …" on the factura — a wrong amount in words is a fiscal mismatch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { montoEnLetras, enteroALetras } from '../src/lib/numeroEnLetras.js';

test('enteroALetras across ranges', () => {
  assert.equal(enteroALetras(0), 'cero');
  assert.equal(enteroALetras(15), 'quince');
  assert.equal(enteroALetras(21), 'veintiuno');
  assert.equal(enteroALetras(45), 'cuarenta y cinco');
  assert.equal(enteroALetras(100), 'cien');
  assert.equal(enteroALetras(101), 'ciento uno');
  assert.equal(enteroALetras(800), 'ochocientos');
  assert.equal(enteroALetras(1800), 'mil ochocientos');
  assert.equal(enteroALetras(11800), 'once mil ochocientos');
  assert.equal(enteroALetras(1000000), 'un millón');
  assert.equal(enteroALetras(2500000), 'dos millones quinientos mil');
});

test('montoEnLetras: DOP format, apocope + centavos', () => {
  assert.equal(montoEnLetras(11800), 'ONCE MIL OCHOCIENTOS PESOS CON 00/100');
  assert.equal(montoEnLetras(1), 'UN PESO CON 00/100');           // singular + apocope
  assert.equal(montoEnLetras(21), 'VEINTIÚN PESOS CON 00/100');   // veintiuno → veintiún
  assert.equal(montoEnLetras(101.5), 'CIENTO UN PESOS CON 50/100');
  assert.equal(montoEnLetras(1180.99), 'MIL CIENTO OCHENTA PESOS CON 99/100');
});

test('montoEnLetras: cents rounding carries into the integer', () => {
  assert.equal(montoEnLetras(0.999), 'UN PESO CON 00/100'); // 0.999 → 1.00
  assert.equal(montoEnLetras(0), 'CERO PESOS CON 00/100');
});
