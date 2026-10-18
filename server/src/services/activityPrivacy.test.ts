import assert from 'node:assert/strict';
import test from 'node:test';
import { activityActorProjection } from './activityPrivacy';

test('non-admin activity actor data omits email', () => {
  assert.equal(activityActorProjection('client'), 'name role');
  assert.equal(activityActorProjection('agent'), 'name role');
});

test('admin activity keeps operational actor fields', () => {
  assert.equal(activityActorProjection('admin'), 'name email role');
});
