import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REWARDS, selectReward } from '../../shared/catalog';
import { IDLE_MS, isExpired } from '../../shared/model';
test('catalog contains the 20 distinct Starfinder house rewards', () => {
  assert.equal(REWARDS.length, 20); assert.equal(new Set(REWARDS.map(r => r.id)).size, 20);
  assert.equal(REWARDS[0].name, 'Steady Aim'); assert.equal(REWARDS[19].name, 'Trailblazer');
  assert.ok(REWARDS.every(r => r.name && r.qualifyingRoll));
});
test('every reward occupies an equal random interval, including endpoints', () => {
  REWARDS.forEach((reward, i) => assert.deepEqual(selectReward(() => (i + 0.5) / 20), reward));
  assert.deepEqual(selectReward(() => 0), REWARDS[0]);
  assert.deepEqual(selectReward(() => 0.99999999), REWARDS[19]);
  for (const value of [-1, 1, NaN, Infinity]) assert.throws(() => selectReward(() => value));
});
test('session expiration is exactly 24 hours and inclusive at the deadline', () => {
  assert.equal(IDLE_MS, 86400000);
  assert.equal(isExpired({ expiresAt: IDLE_MS }, IDLE_MS - 1), false);
  assert.equal(isExpired({ expiresAt: IDLE_MS }, IDLE_MS), true);
});
