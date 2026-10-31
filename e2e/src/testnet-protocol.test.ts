import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectTestnetProtocol, selectTestnetScenario } from './testnet-protocol.js';

test('protocol selection preserves explicit versions and default V5 flows', () => {
  assert.equal(selectTestnetProtocol(undefined, []), '5');
  assert.equal(selectTestnetProtocol('2', []), '2');
  assert.equal(selectTestnetProtocol('4', []), '4');
  assert.equal(selectTestnetProtocol(undefined, ['--v4']), '4');
  assert.equal(selectTestnetProtocol('4', ['--v4']), '4');
  assert.equal(selectTestnetProtocol('5', []), '5');
  assert.equal(selectTestnetProtocol(undefined, ['--v5']), '5');
});

test('registration scenario cannot deploy or silently select another network', () => {
  assert.equal(selectTestnetScenario(undefined, '2'), 'deployment');
  assert.equal(selectTestnetScenario('deployment', '4'), 'deployment');
  assert.equal(selectTestnetScenario('registration', '4'), 'registration');
  assert.equal(selectTestnetScenario('registration', '5'), 'registration');
  assert.throws(() => selectTestnetScenario('registration', '2'), /requires/);
  assert.throws(() => selectTestnetScenario('registation', '4'), /must be/);
});

test('unknown or conflicting selection never falls back to a transaction runner', () => {
  for (const value of ['', '3', 'v4', '04', '6']) assert.throws(() => selectTestnetProtocol(value, []), /must be 2, 4 or 5/);
  assert.throws(() => selectTestnetProtocol('2', ['--v4']), /conflicts/);
  assert.throws(() => selectTestnetProtocol('5', ['--v4']), /conflicts/);
  assert.throws(() => selectTestnetProtocol(undefined, ['--v4','--v5']), /conflict/);
  assert.throws(() => selectTestnetProtocol(undefined, ['--typo']), /Only/);
});
