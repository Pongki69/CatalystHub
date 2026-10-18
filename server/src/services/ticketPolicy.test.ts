import assert from 'node:assert/strict';
import test from 'node:test';
import { canChangeAssignee, canSetTicketStatusDirectly, hasAgentHistory, returnReopenedWorkToQueue } from './ticketPolicy';

test('review and resolved statuses require their dedicated workflow actions', () => {
  assert.equal(canSetTicketStatusDirectly('admin', 'Ready for review'), false);
  assert.equal(canSetTicketStatusDirectly('agent', 'Ready for review'), false);
  assert.equal(canSetTicketStatusDirectly('admin', 'Resolved'), false);
  assert.equal(canSetTicketStatusDirectly('client', 'In Progress'), false);
  assert.equal(canSetTicketStatusDirectly('admin', 'Closed'), true);
});

test('only admins may reassign outside client review', () => {
  assert.equal(canChangeAssignee('admin', 'In Progress'), true);
  assert.equal(canChangeAssignee('agent', 'In Progress'), false);
  assert.equal(canChangeAssignee('client', 'Open'), false);
  assert.equal(canChangeAssignee('admin', 'Ready for review'), false);
});

test('agent deletion is allowed only when no historical work references remain', () => {
  const empty = { requestMessages: false, privateMessages: false, legacyComments: false, assignmentsOrProposals: false, completionCredit: false };
  assert.equal(hasAgentHistory(empty), false);
  for (const signal of Object.keys(empty) as (keyof typeof empty)[]) assert.equal(hasAgentHistory({ ...empty, [signal]: true }), true);
});

test('reopened requests return to the agency queue when the agent is unavailable', () => {
  assert.equal(returnReopenedWorkToQueue(false), true);
  assert.equal(returnReopenedWorkToQueue(true), false);
});
