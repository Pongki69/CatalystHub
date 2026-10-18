import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationRecipientFilter } from './notificationScope';

test('notification access stays scoped to the signed-in admin recipient', () => {
  assert.deepEqual(notificationRecipientFilter('admin-a'), { recipient: 'admin-a' });
});

test('notification access stays scoped to the signed-in non-admin recipient', () => {
  assert.deepEqual(notificationRecipientFilter('agent-b'), { recipient: 'agent-b' });
});
