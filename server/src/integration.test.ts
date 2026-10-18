import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { app } from './app';
import { AuditLog } from './models/AuditLog';
import { Notification } from './models/Notification';
import { ThreadMessage } from './models/ThreadMessage';
import { TeamMessage } from './models/TeamMessage';
import { Ticket } from './models/Ticket';
import { User, type UserRole } from './models/User';

const testDatabaseName = 'mympp_test';
const uri = process.env.MONGODB_URI || '';
const runId = randomUUID();
const userIds: mongoose.Types.ObjectId[] = [];
const ticketIds: mongoose.Types.ObjectId[] = [];
let server: ReturnType<typeof app.listen> | undefined;

function assertTestDatabaseTarget(): void {
  if (!uri) throw new Error('MONGODB_URI must be set by server/.env.test.');
  const parsed = new URL(uri);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database !== testDatabaseName) {
    throw new Error(`Refusing integration tests against database "${database}"; expected "${testDatabaseName}".`);
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`Refusing integration tests against non-local MongoDB host "${parsed.hostname}".`);
  }
  if (!process.env.JWT_SECRET?.includes('test-only')) throw new Error('Integration tests require the test-only JWT secret from server/.env.test.');
}

async function request(path: string, token?: string, method = 'GET', body?: unknown) {
  const address = server?.address() as AddressInfo | null;
  assert.ok(address, 'test API server should be listening');
  return fetch(`http://127.0.0.1:${address.port}/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function tokenFor(user: { _id: mongoose.Types.ObjectId; role: UserRole }): string {
  return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET!, { expiresIn: '5m' });
}

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  if (mongoose.connection.readyState === 1) {
    // These filters only target random IDs created and recorded by this test run.
    await Promise.all([
      ThreadMessage.deleteMany({ ticket: { $in: ticketIds } }),
      TeamMessage.deleteMany({ ticket: { $in: ticketIds } }),
      Notification.deleteMany({ ticket: { $in: ticketIds } }),
      AuditLog.deleteMany({ $or: [{ actor: { $in: userIds } }, { ticket: { $in: ticketIds } }] }),
      Ticket.deleteMany({ _id: { $in: ticketIds } }),
      User.deleteMany({ _id: { $in: userIds } }),
    ]);
    await mongoose.disconnect();
  }
});

test('MongoDB-backed role boundaries, conditional transitions, and declared indexes', async () => {
  assertTestDatabaseTarget();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  assert.equal(mongoose.connection.name, testDatabaseName, 'connected database must be mympp_test');

  // Create declared indexes additively; never use syncIndexes(), which may drop indexes.
  for (const modelName of mongoose.modelNames()) {
    const model = mongoose.model(modelName);
    await model.createIndexes();
    const actualIndexes = await model.collection.indexes();
    for (const [key, options] of model.schema.indexes()) {
      const actual = actualIndexes.find(index => JSON.stringify(index.key) === JSON.stringify(key));
      assert.ok(actual, `${modelName} missing declared index ${JSON.stringify(key)}`);
      if (options.unique) assert.equal(actual.unique, true, `${modelName} index ${JSON.stringify(key)} should be unique`);
      if (options.sparse) assert.equal(actual.sparse, true, `${modelName} index ${JSON.stringify(key)} should be sparse`);
    }
  }

  const suffix = runId.replaceAll('-', '');
  const users = await User.create([
    { name: 'Test Client', email: `client-${suffix}@example.invalid`, passwordHash: 'unused-test-hash', role: 'client' },
    { name: 'Other Client', email: `other-client-${suffix}@example.invalid`, passwordHash: 'unused-test-hash', role: 'client' },
    { name: 'Test Agent', email: `agent-${suffix}@example.invalid`, passwordHash: 'unused-test-hash', role: 'agent', approvalStatus: 'approved' },
    { name: 'Other Agent', email: `other-agent-${suffix}@example.invalid`, passwordHash: 'unused-test-hash', role: 'agent', approvalStatus: 'approved' },
    { name: 'Test Admin', email: `admin-${suffix}@example.invalid`, passwordHash: 'unused-test-hash', role: 'admin' },
    { name: 'Replacement Agent', email: `replacement-agent-${suffix}@example.invalid`, passwordHash: 'unused-test-hash', role: 'agent', approvalStatus: 'approved' },
  ]);
  userIds.push(...users.map(user => user._id));
  const [client, otherClient, agent, otherAgent, admin, replacementAgent] = users;
  const tickets = await Ticket.create([
    { title: 'Integration review A', description: 'A test request for role and review checks.', category: 'Testing', status: 'Ready for review', clientId: client._id, assignedTo: agent._id, workCompletedBy: agent._id, workCompletedAt: new Date() },
    { title: 'Integration foreign request', description: 'A private client request for access checks.', category: 'Testing', status: 'Open', clientId: otherClient._id },
    { title: 'Integration assignment request', description: 'An open request for admin assignment checks.', category: 'Testing', status: 'Open', clientId: client._id },
    { title: 'Integration review race', description: 'A request for concurrent resolve checks.', category: 'Testing', status: 'Ready for review', clientId: client._id, assignedTo: agent._id, workCompletedBy: agent._id, workCompletedAt: new Date() },
    { title: 'Integration team progress', description: 'An in-progress request for team coordination checks.', category: 'Testing', status: 'In Progress', clientId: client._id, assignedTo: agent._id },
    { title: 'Integration teammate calendar request', description: 'A teammate request that should not appear on this agent calendar.', category: 'Testing', status: 'In Progress', clientId: client._id, assignedTo: otherAgent._id },
    { title: 'Integration resolved calendar request', description: 'A completed request that should not appear on an agent calendar.', category: 'Testing', status: 'Resolved', clientId: client._id, assignedTo: agent._id },
  ]);
  ticketIds.push(...tickets.map(ticket => ticket._id));
  const [reviewTicket, foreignTicket, assignmentTicket, raceTicket, progressTicket] = tickets;
  const clientToken = tokenFor(client);
  const otherClientToken = tokenFor(otherClient);
  const agentToken = tokenFor(agent);
  const otherAgentToken = tokenFor(otherAgent);
  const adminToken = tokenFor(admin);
  const replacementAgentToken = tokenFor(replacementAgent);

  server = app.listen(0);
  await new Promise<void>(resolve => server!.once('listening', resolve));

  assert.equal((await request('/tickets')).status, 401, 'unauthenticated requests must be rejected');
  assert.equal((await request(`/tickets/${reviewTicket.id}`, clientToken)).status, 200, 'client can read their request');
  assert.equal((await request(`/tickets/${foreignTicket.id}`, clientToken)).status, 404, 'client cannot read another client request');
  const calendarResponse = await request('/tickets?assignment=calendar', agentToken);
  assert.equal(calendarResponse.status, 200, 'agents can load their scoped calendar requests');
  const calendarPayload = await calendarResponse.json() as { data: { tickets: Array<{ _id: string; status: string; assignedTo?: { id?: string; _id?: string } | null }> } };
  const calendarRows = calendarPayload.data.tickets;
  const calendarIds = new Set(calendarRows.map(ticket => ticket._id));
  assert.ok(calendarIds.has(progressTicket.id), 'agent calendar includes the agent’s active assigned work');
  assert.ok(calendarIds.has(assignmentTicket.id) && calendarIds.has(foreignTicket.id), 'agent calendar includes open unassigned requests available to pick up');
  assert.ok(!calendarIds.has(tickets[5].id), 'agent calendar hides another agent’s active request');
  assert.ok(!calendarIds.has(tickets[6].id), 'agent calendar hides resolved assigned work');
  assert.ok(calendarRows.every(ticket => ticket.status === 'Open' || (ticket.assignedTo?.id || ticket.assignedTo?._id) === agent.id), 'agent calendar contains only open requests or requests assigned to the current agent');
  const otherAgentResponse = await request(`/tickets/${reviewTicket.id}`, otherAgentToken);
  assert.equal(otherAgentResponse.status, 200, 'agents can inspect requests handled by teammates');
  const otherAgentPayload = await otherAgentResponse.json() as { data: { messages: unknown[] } };
  assert.deepEqual(otherAgentPayload.data.messages, [], 'unassigned agents cannot read the request conversation');
  assert.equal((await request(`/tickets/${reviewTicket.id}`, agentToken, 'PATCH', { status: 'Ready for review' })).status, 403, 'agents must use the delivery handoff rather than bypassing it');
  assert.equal((await request(`/tickets/${reviewTicket.id}/resolve`, agentToken, 'PATCH', {})).status, 403, 'agents cannot confirm client resolution');
  assert.ok([404, 409].includes((await request(`/tickets/${reviewTicket.id}/resolve`, otherClientToken, 'PATCH', {})).status), 'clients cannot resolve another client request');
  const protectedReviewTicket = await Ticket.findById(reviewTicket._id).select('status');
  assert.equal(protectedReviewTicket?.status, 'Ready for review', 'rejected cross-client resolve must leave the request unchanged');
  assert.equal((await request(`/tickets/${reviewTicket.id}`, adminToken, 'PATCH', { status: 'Ready for review' })).status, 403, 'admins cannot bypass delivery handoff');
  assert.equal((await request(`/tickets/${assignmentTicket.id}`, adminToken, 'PATCH', { assignedTo: agent.id, status: 'In Progress' })).status, 200, 'admin can assign an approved agent and start the work');
  assert.ok(await Notification.exists({ recipient: agent._id, ticket: assignmentTicket._id, type: 'status_changed' }), 'the assigned owner receives status updates');
  assert.ok(await Notification.exists({ recipient: agent._id, ticket: assignmentTicket._id, type: 'assignee_changed' }), 'the new owner receives the assignment notification');
  assert.equal((await request(`/tickets/${assignmentTicket.id}`, adminToken, 'PATCH', { assignedTo: null })).status, 200, 'admin can release an assignment');
  assert.ok(await Notification.exists({ recipient: agent._id, ticket: assignmentTicket._id, type: 'assignee_changed', title: 'Request assignment changed' }), 'the previous owner is notified of reassignment');

  assert.equal((await request(`/tickets/${progressTicket.id}/progress`, otherAgentToken, 'POST', { summary: 'Teammate attempt', assistanceNeeded: false })).status, 409, 'only the assigned agent can update team progress');
  assert.equal((await request(`/tickets/${progressTicket.id}`, otherAgentToken, 'PATCH', { status: 'In Progress' })).status, 403, 'teammates cannot modify an assigned request');
  assert.equal((await request(`/tickets/${progressTicket.id}/progress`, clientToken, 'POST', { summary: 'Client attempt', assistanceNeeded: false })).status, 403, 'clients cannot write team progress');
  const progressResponse = await request(`/tickets/${progressTicket.id}/progress`, agentToken, 'POST', { summary: 'Checkout flow is implemented', completed: 'Cart and payment screens are complete.', nextAction: 'Run accessibility review.', blockers: 'Waiting for the test account.', assistanceNeeded: true });
  assert.equal(progressResponse.status, 200, 'assigned agent can update team-visible progress');
  const progressPayload = await progressResponse.json() as { data: { ticket: { status: string; progressUpdates: Array<{ summary: string; blockers: string; assistanceNeeded: boolean }> } } };
  assert.equal(progressPayload.data.ticket.status, 'In Progress', 'progress updates do not change official request status');
  assert.equal(progressPayload.data.ticket.progressUpdates.at(-1)?.summary, 'Checkout flow is implemented', 'progress summary is persisted');
  assert.ok(await AuditLog.exists({ actor: agent._id, ticket: progressTicket._id, action: 'progress_updated' }), 'team progress update is audited without sharing it with the client');
  await request(`/tickets/${progressTicket.id}/progress`, agentToken, 'POST', { summary: 'Accessibility test account is still pending', blockers: 'Waiting for the staging credential.', assistanceNeeded: true });
  assert.equal(await Notification.countDocuments({ recipient: admin._id, ticket: progressTicket._id, type: 'blocker_attention' }), 1, 'admins receive one deduplicated alert when a blocker is first raised');
  const teammateProgress = await request(`/tickets/${progressTicket.id}`, otherAgentToken);
  const teammateProgressPayload = await teammateProgress.json() as { data: { ticket: { progressUpdates: Array<{ summary: string }>; comments: unknown[] }; messages: unknown[] } };
  assert.equal(teammateProgressPayload.data.ticket.progressUpdates.at(-1)?.summary, 'Accessibility test account is still pending', 'teammates can read the latest authorized team progress');
  assert.equal(teammateProgressPayload.data.ticket.progressUpdates.length, 2, 'progress history is preserved as new updates are added');
  assert.deepEqual(teammateProgressPayload.data.ticket.comments, [], 'teammates cannot read embedded private conversation comments');
  assert.deepEqual(teammateProgressPayload.data.messages, [], 'teammates cannot read request messages');
  const clientProgress = await request(`/tickets/${progressTicket.id}`, clientToken);
  const clientProgressPayload = await clientProgress.json() as { data: { ticket: { progressUpdates: unknown[]; assistanceOffers: unknown[] } } };
  assert.deepEqual(clientProgressPayload.data.ticket.progressUpdates, [], 'team-only progress is hidden from clients');
  assert.deepEqual(clientProgressPayload.data.ticket.assistanceOffers, [], 'internal assistance offers are hidden from clients');

  assert.equal((await request(`/tickets/${progressTicket.id}/assistance-offers`, clientToken, 'POST', { message: 'I can help review the accessibility flow.' })).status, 403, 'clients cannot submit internal assistance offers');
  const offerResponse = await request(`/tickets/${progressTicket.id}/assistance-offers`, otherAgentToken, 'POST', { message: 'I can help review the accessibility flow.' });
  assert.equal(offerResponse.status, 201, 'another agent can offer help without taking ownership');
  const offerPayload = await offerResponse.json() as { data: { ticket: { assistanceOffers: Array<{ _id: string; status: string }> } } };
  const offer = offerPayload.data.ticket.assistanceOffers[0];
  assert.equal(offer.status, 'pending', 'assistance offer starts pending');
  assert.equal((await request(`/tickets/${progressTicket.id}/assistance-offers/${offer._id}`, otherAgentToken, 'PATCH', { status: 'accepted' })).status, 409, 'an offeror cannot approve their own offer');
  assert.equal((await request(`/tickets/${progressTicket.id}/team-messages`, otherAgentToken)).status, 403, 'an offeror cannot access the team thread before acceptance');
  assert.equal((await request(`/tickets/${progressTicket.id}/assistance-offers/${offer._id}`, agentToken, 'PATCH', { status: 'accepted' })).status, 200, 'assigned agent can approve assistance');
  const clientAfterAcceptance = await request(`/tickets/${progressTicket.id}`, clientToken);
  const clientAfterAcceptancePayload = await clientAfterAcceptance.json() as { data: { ticket: { teamCollaborators: Array<{ id: string; name: string }>; assistanceOffers: unknown[]; progressUpdates: unknown[] } } };
  assert.equal(clientAfterAcceptancePayload.data.ticket.teamCollaborators[0]?.id, otherAgent.id, 'clients can see the accepted helper identity without seeing internal offers or discussion');
  assert.deepEqual(clientAfterAcceptancePayload.data.ticket.assistanceOffers, [], 'accepted helper notice does not expose offer details');
  assert.deepEqual(clientAfterAcceptancePayload.data.ticket.progressUpdates, [], 'accepted helper notice does not expose team progress');
  const afterOfferDecision = await Ticket.findById(progressTicket._id).select('status assignedTo assistanceOffers');
  assert.equal(afterOfferDecision?.status, 'In Progress', 'accepting assistance does not change official request status');
  assert.equal(afterOfferDecision?.assignedTo?.toString(), agent.id, 'accepting assistance does not transfer ownership');
  assert.equal(afterOfferDecision?.assistanceOffers[0]?.status, 'accepted', 'offer decision is recorded');
  assert.equal((await request(`/tickets/${progressTicket.id}/team-messages`, otherAgentToken)).status, 200, 'accepted helper can read the private team thread');
  const teamMessageResponse = await request(`/tickets/${progressTicket.id}/team-messages`, otherAgentToken, 'POST', { message: 'I can review the accessibility changes this afternoon.' });
  assert.equal(teamMessageResponse.status, 201, 'accepted helper can send a private team message');
  assert.equal((await request(`/tickets/${progressTicket.id}/team-messages`, agentToken, 'POST', { message: 'Thanks, I will share the test build.' })).status, 201, 'assigned owner can reply in the private team thread');
  assert.equal((await request(`/tickets/${progressTicket.id}/team-messages`, clientToken)).status, 403, 'clients cannot read the private team thread');
  assert.equal((await request(`/tickets/${progressTicket.id}/team-messages`, clientToken, 'POST', { message: 'Client should not see the team thread.' })).status, 403, 'clients cannot post to the private team thread');
  assert.equal((await request(`/tickets/${progressTicket.id}/team-messages`, adminToken)).status, 200, 'admins can review the private team thread');
  assert.equal((await request(`/tickets/${progressTicket.id}/team-messages`, otherAgentToken, 'POST', { message: 'x'.repeat(2001) })).status, 400, 'team messages enforce the 2000 character limit');
  assert.ok(await AuditLog.exists({ actor: otherAgent._id, ticket: progressTicket._id, action: 'team_message_sent' }), 'team messages are audited');
  assert.ok(await Notification.exists({ recipient: agent._id, actor: otherAgent._id, ticket: progressTicket._id, type: 'team_message' }), 'team messages notify the request owner');
  assert.ok([403, 409].includes((await request(`/tickets/${progressTicket.id}/submit-review`, otherAgentToken, 'POST', { message: 'Unauthorized delivery attempt', submissionId: randomUUID() })).status), 'an accepted helper still cannot submit delivery as the owner');
  assert.equal(await Notification.countDocuments({ recipient: agent._id, actor: otherAgent._id, ticket: progressTicket._id, type: 'assistance_offer' }), 1, 'offer notification is delivered only to the assigned owner once');
  assert.ok(await Notification.exists({ recipient: otherAgent._id, actor: agent._id, ticket: progressTicket._id, type: 'assistance_offer' }), 'offer decision notifies the offeror');
  const secondOfferResponse = await request(`/tickets/${progressTicket.id}/assistance-offers`, otherAgentToken, 'POST', { message: 'I can check the accessibility flow as well.' });
  const secondOfferPayload = await secondOfferResponse.json() as { data: { ticket: { assistanceOffers: Array<{ _id: string; status: string }> } } };
  assert.equal(secondOfferResponse.status, 201, 'an agent may make a new offer after the previous one is decided');
  const secondOffer = secondOfferPayload.data.ticket.assistanceOffers.find(item => item.status === 'pending')!;
  assert.equal((await request(`/tickets/${progressTicket.id}/assistance-offers/${secondOffer._id}`, adminToken, 'PATCH', { status: 'accepted' })).status, 200, 'an authorized admin can decide an assistance offer');
  assert.equal(await Notification.countDocuments({ recipient: agent._id, actor: otherAgent._id, ticket: progressTicket._id, type: 'assistance_offer' }), 2, 'each distinct offer creates one owner notification without duplicate notifications');
  assert.equal((await request(`/tickets/${progressTicket.id}`, adminToken, 'PATCH', { assignedTo: replacementAgent.id })).status, 200, 'admins can reassign a request to another approved agent');
  assert.equal((await request(`/tickets/${progressTicket.id}/team-messages`, otherAgentToken)).status, 403, 'accepted helper loses former-owner thread access after reassignment');
  assert.equal((await request(`/tickets/${progressTicket.id}/team-messages`, replacementAgentToken)).status, 200, 'new assigned owner can access the team thread');
  const reassignedClient = await request(`/tickets/${progressTicket.id}`, clientToken);
  const reassignedClientPayload = await reassignedClient.json() as { data: { ticket: { teamCollaborators: unknown[] } } };
  assert.deepEqual(reassignedClientPayload.data.ticket.teamCollaborators, [], 'client helper notice clears when the active owner changes');

  const concurrentResults = await Promise.all([
    request(`/tickets/${raceTicket.id}/resolve`, clientToken, 'PATCH', {}),
    request(`/tickets/${raceTicket.id}/resolve`, clientToken, 'PATCH', {}),
  ]);
  assert.deepEqual(concurrentResults.map(response => response.status).sort(), [200, 409], 'concurrent resolve requests must have exactly one winner');
  const persistedRaceTicket = await Ticket.findById(raceTicket._id).select('status');
  assert.equal(persistedRaceTicket?.status, 'Resolved', 'the winning transition must persist');
});
