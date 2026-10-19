import assert from 'node:assert/strict';
import test from 'node:test';
import { expired, nextExpiry, SESSION_IDLE_MS } from '../functions/src/shared/lifetime';
import { newSession, nextCard, playNumber, restoreSession, rollSession, serializeSession, toggleAward } from '../src/session';

test('expiry is exactly twenty-four hours after activity, including its boundary', () => {
  assert.equal(nextExpiry(1000), 1000 + SESSION_IDLE_MS);
  assert.equal(expired(2000, 1999), false);
  assert.equal(expired(2000, 2000), true);
});

test('solo play extends expiry; reloads and ignored taps do not', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const session = newSession(); const deadline = session.expiresAt;
  t.mock.timers.tick(5000);
  const restored = restoreSession(serializeSession(session))!;
  assert.equal(restored.expiresAt, deadline);
  const played = rollSession(restored, () => 0);
  assert.equal(played.expiresAt, deadline + 5000);
  assert.equal(playNumber(played, 999).expiresAt, played.expiresAt);
  assert.equal(toggleAward(played, 'absent').expiresAt, played.expiresAt);
});

test('expired solo state cannot restore, play its old card, or use its prizes', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const initial = newSession();
  const old = { ...initial, awards: [{ id: 'previous', prize: initial.game.prize, used: false }] };
  t.mock.timers.tick(SESSION_IDLE_MS);
  assert.equal(restoreSession(serializeSession(old)), null);
  for (const fresh of [playNumber(old, 1), rollSession(old), toggleAward(old, 'previous'), nextCard(old)]) {
    assert.equal(fresh.awards.length, 0);
    assert.equal(fresh.game.marked.size, 0);
    assert.notEqual(fresh.cardId, old.cardId);
    assert.equal(fresh.expiresAt, nextExpiry());
  }
});

test('legacy solo saves receive a deadline once and invalid deadlines are rejected', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const data = JSON.parse(serializeSession(newSession())); delete data.expiresAt;
  const migrated = restoreSession(JSON.stringify(data))!;
  assert.equal(migrated.expiresAt, nextExpiry());
  t.mock.timers.tick(1000);
  assert.equal(restoreSession(serializeSession(migrated))!.expiresAt, migrated.expiresAt);
  for (const invalid of ['tomorrow', -1, null, 1.5]) {
    data.expiresAt = invalid; assert.equal(restoreSession(JSON.stringify(data)), null);
  }
});
