import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import mongoose, { Types } from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { DirectConversation } from '../models/DirectConversation';
import { DirectMessage } from '../models/DirectMessage';
import { Notification } from '../models/Notification';
import { ThreadMessage } from '../models/ThreadMessage';
import { Ticket } from '../models/Ticket';
import { User } from '../models/User';

const EXPECTED_DATABASE = 'mympp_test';
const PREVIEW_PASSWORD = 'PreviewOnly#2026';
const manifestPath = resolve(process.cwd(), '.preview-seed.json');
type PreviewManifest = {
  runId: string;
  baselineCounts: Record<string, number>;
  ids: Record<'users' | 'tickets' | 'threadMessages' | 'conversations' | 'directMessages' | 'notifications' | 'auditLogs', string[]>;
};

function assertSafeTarget(): void {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Load server/.env.test before running preview data commands.');
  const parsed = new URL(uri);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database !== EXPECTED_DATABASE || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`Refusing to modify MongoDB target ${parsed.hostname}/${database}; only local ${EXPECTED_DATABASE} is allowed.`);
  }
  if (!process.env.JWT_SECRET?.includes('test-only')) throw new Error('A test-only JWT secret is required.');
}

const objectIds = (values: string[]) => values.map(value => new Types.ObjectId(value));
const saveManifest = (manifest: PreviewManifest) => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

async function removePreviewRecords(manifest: PreviewManifest): Promise<Record<string, number>> {
  const { ids } = manifest;
  const users = objectIds(ids.users);
  const tickets = objectIds(ids.tickets);
  const conversations = objectIds(ids.conversations);
  await Promise.all([
    ThreadMessage.deleteMany({ $or: [{ _id: { $in: objectIds(ids.threadMessages) } }, { ticket: { $in: tickets } }, { sender: { $in: users } }] }),
    DirectMessage.deleteMany({ $or: [{ _id: { $in: objectIds(ids.directMessages) } }, { conversation: { $in: conversations } }, { sender: { $in: users } }] }),
    Notification.deleteMany({ $or: [{ _id: { $in: objectIds(ids.notifications) } }, { ticket: { $in: tickets } }, { conversation: { $in: conversations } }, { actor: { $in: users } }, { recipient: { $in: users } }] }),
    AuditLog.deleteMany({ $or: [{ _id: { $in: objectIds(ids.auditLogs) } }, { ticket: { $in: tickets } }, { conversation: { $in: conversations } }, { actor: { $in: users } }, { participants: { $in: users } }] }),
    Ticket.deleteMany({ $or: [{ _id: { $in: tickets } }, { clientId: { $in: users } }, { assignedTo: { $in: users } }, { workCompletedBy: { $in: users } }, { creditedAgent: { $in: users } }] }),
    DirectConversation.deleteMany({ $or: [{ _id: { $in: conversations } }, { participants: { $in: users } }] }),
    User.deleteMany({ _id: { $in: users } }),
  ]);

  const counts: Record<string, number> = {};
  for (const [collection, expected] of Object.entries(manifest.baselineCounts)) {
    counts[collection] = await mongoose.connection.db!.collection(collection).countDocuments();
    if (counts[collection] !== expected) throw new Error(`Preview records were removed, but ${collection} now has ${counts[collection]} documents (baseline ${expected}). Unrelated data may have changed during the preview; it was left untouched.`);
  }
  return counts;
}

async function seedPreview(): Promise<void> {
  if (existsSync(manifestPath)) throw new Error('A preview seed manifest already exists. Run reset:preview before seeding again.');
  const runId = randomUUID();
  const suffix = runId.replaceAll('-', '').slice(0, 12);
  const users = Object.fromEntries(['admin', 'maya', 'aaron', 'priya', 'jordan', 'sam', 'taylor'].map(role => [role, new Types.ObjectId()])) as Record<string, Types.ObjectId>;
  const ticketIds = Array.from({ length: 7 }, () => new Types.ObjectId());
  const threadIds = Array.from({ length: 8 }, () => new Types.ObjectId());
  const conversationIds = [new Types.ObjectId()];
  const directMessageIds = Array.from({ length: 3 }, () => new Types.ObjectId());
  const notificationIds = Array.from({ length: 4 }, () => new Types.ObjectId());
  const auditIds = Array.from({ length: 5 }, () => new Types.ObjectId());
  const ids: PreviewManifest['ids'] = {
    users: Object.values(users).map(id => id.toString()), tickets: ticketIds.map(id => id.toString()),
    threadMessages: threadIds.map(id => id.toString()), conversations: conversationIds.map(id => id.toString()),
    directMessages: directMessageIds.map(id => id.toString()), notifications: notificationIds.map(id => id.toString()), auditLogs: auditIds.map(id => id.toString()),
  };
  const emailKeys = ['admin', 'maya', 'aaron', 'priya', 'jordan', 'sam', 'taylor'];
  const emails = emailKeys.map(key => `preview.${key}.${suffix}@example.test`);
  if (await User.exists({ email: { $in: emails } })) throw new Error('A generated preview email already exists; no records were changed.');
  const idCollisionChecks = await Promise.all([
    User.exists({ _id: { $in: objectIds(ids.users) } }), Ticket.exists({ _id: { $in: objectIds(ids.tickets) } }),
    ThreadMessage.exists({ _id: { $in: objectIds(ids.threadMessages) } }), DirectConversation.exists({ _id: { $in: objectIds(ids.conversations) } }),
    DirectMessage.exists({ _id: { $in: objectIds(ids.directMessages) } }), Notification.exists({ _id: { $in: objectIds(ids.notifications) } }),
    AuditLog.exists({ _id: { $in: objectIds(ids.auditLogs) } }),
  ]);
  if (idCollisionChecks.some(Boolean)) throw new Error('A generated preview ID already exists; no records were changed.');

  const existingCollections = await mongoose.connection.db!.listCollections().toArray();
  const baselineCounts: Record<string, number> = {};
  for (const collection of existingCollections) baselineCounts[collection.name] = await mongoose.connection.db!.collection(collection.name).countDocuments();
  const manifest: PreviewManifest = { runId, baselineCounts, ids };
  // Record exact new IDs before writes so reset remains possible after an interrupted seed.
  saveManifest(manifest);

  try {
    const passwordHash = await bcrypt.hash(PREVIEW_PASSWORD, 10);
    const userRows = [
      { _id: users.admin, name: 'Morgan Rivera', email: emails[0], role: 'admin' as const, jobTitle: 'Workspace administrator', company: 'Catalyst Studio' },
      { _id: users.maya, name: 'Maya Chen', email: emails[1], role: 'client' as const, company: 'Northstar Wellness', jobTitle: 'Marketing director' },
      { _id: users.aaron, name: 'Aaron Brooks', email: emails[2], role: 'client' as const, company: 'Fieldnote Coffee', jobTitle: 'Founder' },
      { _id: users.priya, name: 'Priya Nair', email: emails[3], role: 'client' as const, company: 'BrightPath Learning', jobTitle: 'Operations lead' },
      { _id: users.jordan, name: 'Jordan Lee', email: emails[4], role: 'agent' as const, approvalStatus: 'approved' as const, company: 'Catalyst Studio', jobTitle: 'Product designer' },
      { _id: users.sam, name: 'Sam Okafor', email: emails[5], role: 'agent' as const, approvalStatus: 'approved' as const, company: 'Catalyst Studio', jobTitle: 'Growth strategist' },
      { _id: users.taylor, name: 'Taylor Kim', email: emails[6], role: 'agent' as const, approvalStatus: 'approved' as const, company: 'Catalyst Studio', jobTitle: 'Web developer' },
    ];
    await User.create(userRows.map(user => ({ ...user, passwordHash })));
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    const ahead = (days: number) => new Date(Date.now() + days * 86_400_000);

    const ticketRows = [
      { _id: ticketIds[0], title: 'Refresh the product landing page', description: 'Update the hero story, clarify product benefits, and improve the mobile layout before the next campaign.', category: 'Website & development', priority: 'High', status: 'In Progress', clientId: users.maya, assignedTo: users.jordan, dueDate: ahead(4), createdAt: ago(5), updatedAt: ago(1) },
      { _id: ticketIds[1], title: 'Q3 digital marketing strategy and channel audit', description: 'Review organic search, email campaigns, and paid ads. Share practical recommendations for next quarter.', category: 'Strategy & consulting', priority: 'Medium', status: 'Ready for review', clientId: users.aaron, assignedTo: users.sam, workCompletedBy: users.sam, workCompletedAt: ago(1), dueDate: ahead(2), createdAt: ago(8), updatedAt: ago(1) },
      { _id: ticketIds[2], title: 'Create a new customer onboarding email series', description: 'Plan a welcoming five-email sequence that helps new customers make their first purchase.', category: 'Marketing & content', priority: 'High', status: 'Open', clientId: users.priya, dueDate: ahead(9), proposals: [{ agent: users.jordan, message: 'I would map the first-week journey, write the email sequence, and define a success measure for every message.', createdAt: ago(1), updateCount: 1 }, { agent: users.taylor, message: 'I can build a responsive email set and test the templates across common inboxes.', createdAt: ago(2), updateCount: 0 }], createdAt: ago(3), updatedAt: ago(1) },
      { _id: ticketIds[3], title: 'Improve analytics dashboard readability', description: 'Make monthly performance easier to scan and highlight metrics that need attention.', category: 'Analytics & reporting', priority: 'Low', status: 'Resolved', clientId: users.maya, assignedTo: users.jordan, workCompletedBy: users.jordan, workCompletedAt: ago(12), creditedAgent: users.jordan, resolutionConfirmedBy: users.maya, resolutionConfirmedAt: ago(11), agentRating: 5, createdAt: ago(20), updatedAt: ago(11) },
      { _id: ticketIds[4], title: 'Prepare community launch assets', description: 'Create a launch checklist and social graphics for the upcoming community announcement.', category: 'Design & creative', priority: 'Medium', status: 'Open', clientId: users.aaron, createdAt: ago(2), updatedAt: ago(2) },
      { _id: ticketIds[5], title: 'Fix the mobile navigation overlap', description: 'Audit the site navigation on small screens and keep the primary action visible when the menu opens.', category: 'Website & development', priority: 'High', status: 'In Progress', clientId: users.priya, assignedTo: users.taylor, dueDate: ahead(2), createdAt: ago(4), updatedAt: ago(0) },
      { _id: ticketIds[6], title: 'Organize the brand guidelines library', description: 'Bring current brand files into a consistent folder structure and note which versions are current.', category: 'Design & creative', priority: 'Low', status: 'Closed', clientId: users.maya, assignedTo: users.sam, createdAt: ago(32), updatedAt: ago(24) },
    ];
    await Ticket.create(ticketRows);

    const threadRows = [
      { _id: threadIds[0], ticket: ticketIds[0], sender: users.maya, message: 'The mobile hero is the priority. Please keep the signup button visible without scrolling.', createdAt: ago(4) },
      { _id: threadIds[1], ticket: ticketIds[0], sender: users.jordan, message: 'I have a first layout ready and am checking phone and tablet widths today.', createdAt: ago(2) },
      { _id: threadIds[2], ticket: ticketIds[0], sender: users.maya, message: 'That sounds good. Please keep the current headline tone.', createdAt: ago(1) },
      { _id: threadIds[3], ticket: ticketIds[1], sender: users.sam, message: 'I reviewed search, email, and paid channels. The recommendations are ready for your review.', createdAt: ago(1) },
      { _id: threadIds[4], ticket: ticketIds[1], sender: users.aaron, message: 'Thanks, I will go through the channel priorities this afternoon.', createdAt: ago(0) },
      { _id: threadIds[5], ticket: ticketIds[3], sender: users.jordan, message: 'The dashboard now groups monthly measures and highlights metrics that need action.', createdAt: ago(12) },
      { _id: threadIds[6], ticket: ticketIds[3], sender: users.maya, message: 'This is much easier to scan. Thank you!', createdAt: ago(11) },
      { _id: threadIds[7], ticket: ticketIds[5], sender: users.taylor, message: 'I reproduced the overlap on narrow screens and am updating menu spacing and focus behavior.', createdAt: ago(0) },
    ];
    await ThreadMessage.create(threadRows);

    const pair = [users.maya.toString(), users.jordan.toString()].sort();
    await DirectConversation.create({ _id: conversationIds[0], participants: pair, participantKey: pair.join(':'), lastMessageAt: ago(0) });
    await DirectMessage.create([
      { _id: directMessageIds[0], conversation: conversationIds[0], sender: users.jordan, message: 'I shared the updated landing-page outline in the request thread.', createdAt: ago(2) },
      { _id: directMessageIds[1], conversation: conversationIds[0], sender: users.maya, message: 'Great. I will send the latest campaign copy this morning.', createdAt: ago(1) },
      { _id: directMessageIds[2], conversation: conversationIds[0], sender: users.jordan, message: 'Perfect, I will use it in the mobile hero draft.', createdAt: ago(0) },
    ]);

    await Notification.create([
      { _id: notificationIds[0], recipient: users.maya, actor: users.jordan, ticket: ticketIds[0], type: 'comment_added', title: 'Jordan added an update', message: 'There is a new update on “Refresh the product landing page”.', readAt: null },
      { _id: notificationIds[1], recipient: users.aaron, actor: users.sam, ticket: ticketIds[1], type: 'status_changed', title: 'Work is ready for review', message: 'Sam sent the channel audit for your review.', readAt: null },
      { _id: notificationIds[2], recipient: users.priya, actor: users.taylor, ticket: ticketIds[5], type: 'comment_added', title: 'Taylor added an update', message: 'There is a new update on “Fix the mobile navigation overlap”.', readAt: null },
      { _id: notificationIds[3], recipient: users.maya, actor: users.jordan, conversation: conversationIds[0], type: 'private_message', title: 'New message from Jordan', message: 'Perfect, I will use it in the mobile hero draft.', readAt: null },
    ]);

    await AuditLog.create([
      { _id: auditIds[0], actor: users.maya, participants: [users.maya, users.jordan], action: 'ticket_created', summary: 'Maya created “Refresh the product landing page”', ticket: ticketIds[0], createdAt: ago(5) },
      { _id: auditIds[1], actor: users.jordan, participants: [users.maya, users.jordan], action: 'assignee_changed', summary: 'Jordan was assigned to the landing page request', ticket: ticketIds[0], createdAt: ago(4) },
      { _id: auditIds[2], actor: users.sam, participants: [users.aaron, users.sam], action: 'work_ready_for_review', summary: 'Sam sent the channel audit for client review', ticket: ticketIds[1], createdAt: ago(1) },
      { _id: auditIds[3], actor: users.maya, participants: [users.maya, users.jordan], action: 'client_resolved', summary: 'Maya confirmed the analytics dashboard work', ticket: ticketIds[3], createdAt: ago(11) },
      { _id: auditIds[4], actor: users.taylor, participants: [users.priya, users.taylor], action: 'status_changed', summary: 'Taylor started the mobile navigation fix', ticket: ticketIds[5], createdAt: ago(3) },
    ]);

    console.log(JSON.stringify({ seeded: true, database: mongoose.connection.name, accounts: emails.map((email, index) => ({ role: ['admin', 'client', 'client', 'client', 'agent', 'agent', 'agent'][index], email })), password: PREVIEW_PASSWORD, requests: ticketRows.length, resetCommand: 'npm run reset:preview --workspace server', manifest: '.preview-seed.json (local, ignored)' }, null, 2));
  } catch (error) {
    await removePreviewRecords(manifest);
    unlinkSync(manifestPath);
    throw error;
  }
}

async function main(): Promise<void> {
  assertSafeTarget();
  await mongoose.connect(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 5000 });
  if (mongoose.connection.name !== EXPECTED_DATABASE) throw new Error(`Connected to unexpected database ${mongoose.connection.name}.`);
  const mode = process.argv[2];
  if (mode === 'seed') await seedPreview();
  else if (mode === 'reset') {
    if (!existsSync(manifestPath)) throw new Error('No preview manifest exists; nothing will be deleted.');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PreviewManifest;
    const restoredCounts = await removePreviewRecords(manifest);
    unlinkSync(manifestPath);
    console.log(JSON.stringify({ reset: true, database: mongoose.connection.name, restoredBaselineCounts: restoredCounts, note: 'Only preview fixtures and records linked to preview users/requests/conversations were removed.' }, null, 2));
  } else throw new Error('Choose the explicit "seed" or "reset" mode.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); });
