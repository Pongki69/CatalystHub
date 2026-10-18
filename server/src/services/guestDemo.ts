import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose, { Types } from 'mongoose';
import { User } from '../models/User';
import { Ticket } from '../models/Ticket';
import { ThreadMessage } from '../models/ThreadMessage';
import { AuditLog } from '../models/AuditLog';
import { DirectConversation } from '../models/DirectConversation';
import { DirectMessage } from '../models/DirectMessage';

export const guestClientId = new Types.ObjectId('65f000000000000000000001');
export const guestAgentId = new Types.ObjectId('65f000000000000000000002');
const sampleTicketId = new Types.ObjectId('65f000000000000000000003');
const designTicketId = new Types.ObjectId('65f000000000000000000004');
const conversationId = new Types.ObjectId('65f000000000000000000005');
const clientEmail = 'guest.client@catalysthub.demo';
const agentEmail = 'guest.agent@catalysthub.demo';

export async function resetGuestDemoData(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Guest demo database is not connected.');
  await mongoose.connection.dropDatabase();
  await Promise.all([User, Ticket, ThreadMessage, AuditLog, DirectConversation, DirectMessage].map(model => model.syncIndexes()));
  const placeholderHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  await User.create([
    { _id: guestClientId, name: 'Guest Client', email: clientEmail, passwordHash: placeholderHash, role: 'client', approvalStatus: 'approved' },
    { _id: guestAgentId, name: 'Guest Agent', email: agentEmail, passwordHash: placeholderHash, role: 'agent', approvalStatus: 'approved' },
  ]);
  await Ticket.create([
    { _id: sampleTicketId, title: 'Refresh the product landing page', description: 'We would like a clearer product story, updated visuals, and a stronger call to action. Please share a first pass for review.', category: 'Design & branding', priority: 'High', status: 'In Progress', clientId: guestClientId, assignedTo: guestAgentId, comments: [] },
    { _id: designTicketId, title: 'Review the mobile navigation', description: 'The navigation is difficult to use on smaller screens. Please recommend a responsive layout and interaction.', category: 'Website & development', priority: 'Medium', status: 'Open', clientId: guestClientId, assignedTo: guestAgentId, comments: [] },
  ]);
  await ThreadMessage.create({ ticket: sampleTicketId, sender: guestClientId, message: 'Could we make the primary call to action easier to spot? I added the latest campaign context to the brief.' });
  await ThreadMessage.create({ ticket: sampleTicketId, sender: guestAgentId, message: 'Absolutely. I am preparing two directions and will share them here for your feedback.' });
  await DirectConversation.create({ _id: conversationId, participants: [guestClientId, guestAgentId], participantKey: [guestClientId.toString(), guestAgentId.toString()].sort().join(':'), lastMessageAt: new Date() });
  await DirectMessage.create({ conversation: conversationId, sender: guestAgentId, message: 'Welcome to the private chat. Use this space for a one-to-one discussion.' });
  await AuditLog.create([
    { actor: guestClientId, participants: [guestClientId], action: 'client_registered', summary: 'Guest Client joined the CatalystHub demo workspace.' },
    { actor: guestClientId, participants: [guestClientId, guestAgentId], ticket: sampleTicketId, action: 'ticket_created', summary: 'Guest Client created “Refresh the product landing page”.' },
    { actor: guestAgentId, participants: [guestClientId, guestAgentId], ticket: sampleTicketId, action: 'status_changed', summary: 'Guest Agent moved “Refresh the product landing page” to In Progress.' },
  ]);
  await db.collection<{ _id: string; resetDate?: string; resetAt?: Date }>('_catalysthub_demo_meta').updateOne(
    { _id: 'daily-reset' },
    { $set: { resetDate: new Date().toISOString().slice(0, 10), resetAt: new Date() } },
    { upsert: true },
  );
}

export async function resetGuestDemoIfDue(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Guest demo database is not connected.');
  const marker = await db.collection<{ _id: string; resetDate?: string; resetAt?: Date }>('_catalysthub_demo_meta').findOne({ _id: 'daily-reset' });
  const today = new Date().toISOString().slice(0, 10);
  if (marker?.resetDate === today) return;
  await resetGuestDemoData();
  console.log(`Guest demo data reset for ${today} UTC.`);
}

export const guestAccountEmails = { client: clientEmail, agent: agentEmail };
