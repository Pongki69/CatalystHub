import { Router } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { Ticket } from '../models/Ticket';
import { User } from '../models/User';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { trackEvent } from '../services/events';
import { ThreadMessage } from '../models/ThreadMessage';
import { Notification } from '../models/Notification';
import { TeamMessage } from '../models/TeamMessage';
import { validateAttachment } from '../services/attachmentValidation';
import { canChangeAssignee, canSetTicketStatusDirectly, returnReopenedWorkToQueue } from '../services/ticketPolicy';
import { threadMessageInputSchema, workReviewSubmissionSchema } from '../services/messageContracts';

export const ticketRouter = Router();
ticketRouter.use(authenticate);
const priorities = ['Low', 'Medium', 'High'] as const;
const statuses = ['Open', 'In Progress', 'Ready for review', 'Resolved', 'Closed'] as const;
const reactionEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
const MAX_AGENT_RESPONSE_UPDATES = 5;
const createSchema = z.object({ title: z.string().trim().min(4).max(140), description: z.string().trim().min(10).max(10000), category: z.string().trim().min(2).max(60), priority: z.enum(priorities).default('Medium'), submissionId: z.string().uuid().optional() });
const populated = [{ path: 'clientId assignedTo workCompletedBy creditedAgent resolutionConfirmedBy', select: 'name role avatarUrl coverUrl' }, { path: 'proposals.agent', select: 'name role avatarUrl company jobTitle' }, { path: 'progressUpdates.author assistanceOffers.agent assistanceOffers.respondedBy', select: 'name role avatarUrl' }];
// Agents can see every client request, including work handled by other agents.
// Only the assigned agent can change workflow status or cancel their assignment.
const visibleTo = (req: AuthRequest) => req.user!.role === 'admin' || req.user!.role === 'agent' ? {} : { clientId: req.user!.id };
const canAccessConversation = (ticket: { assignedTo?: Types.ObjectId | { _id?: Types.ObjectId } | null }, req: AuthRequest) => {
  const assigned = ticket.assignedTo as unknown as { _id?: Types.ObjectId; toString(): string } | null | undefined;
  const assignedId = assigned?._id?.toString() || assigned?.toString();
  return req.user!.role === 'admin' || req.user!.role === 'client' || (req.user!.role === 'agent' && assignedId === req.user!.id);
};
const canManageAssistanceOffers = (ticket: { assignedTo?: Types.ObjectId | { _id?: Types.ObjectId } | null }, req: AuthRequest) => {
  const assigned = ticket.assignedTo as unknown as { _id?: Types.ObjectId; toString(): string } | null | undefined;
  const assignedId = assigned?._id?.toString() || assigned?.toString();
  return req.user!.role === 'admin' || (req.user!.role === 'agent' && assignedId === req.user!.id);
};
const referenceId = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const reference = value as { _id?: unknown; toString(): string };
    if (reference._id && reference._id !== value) return String(reference._id);
    return reference.toString();
  }
  return '';
};
const canAccessTeamThread = (ticket: { assignedTo?: unknown; assistanceOffers?: Array<{ agent: unknown; status: string; respondedBy?: unknown }> }, req: AuthRequest) => {
  if (req.user!.role === 'admin') return true;
  const ownerId = referenceId(ticket.assignedTo);
  if (!ownerId) return false;
  if (req.user!.role === 'agent' && ownerId === req.user!.id) return true;
  return req.user!.role === 'agent' && (ticket.assistanceOffers || []).some(offer => offer.status === 'accepted' && referenceId(offer.agent) === req.user!.id && referenceId((offer as typeof offer & { acceptedFor?: unknown }).acceptedFor) === ownerId);
};
const activeTeamMemberIds = (ticket: { assignedTo?: unknown; assistanceOffers?: Array<{ agent: unknown; status: string; respondedBy?: unknown }> }) => {
  const ownerId = referenceId(ticket.assignedTo);
  return [...new Set([ownerId, ...(ticket.assistanceOffers || []).filter(offer => offer.status === 'accepted' && referenceId((offer as typeof offer & { acceptedFor?: unknown }).acceptedFor) === ownerId).map(offer => referenceId(offer.agent))].filter(Boolean))];
};
const hideTeamCoordinationFromClient = (ticket: { set: (path: string, value: unknown) => void }, req: AuthRequest) => {
  if (req.user!.role === 'client') {
    const collaborators = (ticket as unknown as { get: (path: string) => unknown }).get('teamCollaborators') || [];
    ticket.set('teamCollaborators', collaborators);
    ticket.set('progressUpdates', []);
    ticket.set('assistanceOffers', []);
  }
};
const hideOtherAgentProposals = (ticket: { proposals?: Array<{ agent: Types.ObjectId }> } & { set: (path: string, value: unknown) => void }, req: AuthRequest) => {
  if (req.user!.role === 'agent') ticket.set('proposals', (ticket.proposals || []).filter(proposal => {
    const agent = proposal.agent as unknown as { _id?: Types.ObjectId; toString(): string };
    return (agent._id?.toString() || agent.toString()) === req.user!.id;
  }));
};

ticketRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const filter: Record<string, unknown> = { ...visibleTo(req) };
    if (typeof req.query.status === 'string' && statuses.includes(req.query.status as typeof statuses[number])) {
      filter.status = req.query.status;
    }
    if (typeof req.query.priority === 'string' && priorities.includes(req.query.priority as typeof priorities[number])) filter.priority = req.query.priority;
    if (req.user!.role === 'agent' && typeof req.query.assignment === 'string') {
      if (req.query.assignment === 'mine') filter.assignedTo = req.user!.id;
      else if (req.query.assignment === 'unassigned') { filter.assignedTo = null; if (!filter.status) filter.status = 'Open'; }
      else if (req.query.assignment === 'teammate') filter.assignedTo = { $ne: null, $exists: true, $nin: [req.user!.id] };
      else if (req.query.assignment === 'review') filter.status = 'Ready for review';
      else if (req.query.assignment === 'calendar') filter.$and = [...((filter.$and as Record<string, unknown>[] | undefined) || []), { $or: [{ assignedTo: req.user!.id, status: { $in: ['Open', 'In Progress', 'Ready for review'] } }, { assignedTo: null, status: 'Open' }] }];
    }
    if (req.user!.role === 'admin' && (req.query.unassigned === 'true' || req.query.active === 'true') && !filter.status) filter.status = { $in: ['Open', 'In Progress', 'Ready for review'] };
    if (req.user!.role === 'admin' && req.query.unassigned === 'true') filter.assignedTo = null;
    if (typeof req.query.clientId === 'string') {
      if (!isValidObjectId(req.query.clientId)) { res.status(400).json({ success: false, message: 'Choose a valid client profile.' }); return; }
      if (req.user!.role === 'client' && req.query.clientId !== req.user!.id) { res.status(403).json({ success: false, message: 'You can only view your own requests.' }); return; }
      filter.clientId = req.query.clientId;
    }
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      const escaped = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$and = [{ $or: [{ title: { $regex: escaped, $options: 'i' } }, { description: { $regex: escaped, $options: 'i' } }, { category: { $regex: escaped, $options: 'i' } }] }];
    }
    const fromText = typeof req.query.from === 'string' ? req.query.from : '';
    const toText = typeof req.query.to === 'string' ? req.query.to : '';
    if (fromText || toText) {
      const from = fromText ? new Date(`${fromText}T00:00:00.000Z`) : null;
      const to = toText ? new Date(`${toText}T23:59:59.999Z`) : null;
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) { res.status(400).json({ success: false, message: 'Choose valid calendar dates.' }); return; }
      const dueRange = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
      const createdRange = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
      filter.$and = [...((filter.$and as Record<string, unknown>[] | undefined) || []), { $or: [{ dueDate: dueRange }, { dueDate: null, createdAt: createdRange }] }];
    }
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 50;
    const cursorDateText = typeof req.query.beforeDate === 'string' ? req.query.beforeDate : '';
    const cursorIdText = typeof req.query.beforeId === 'string' ? req.query.beforeId : '';
    const cursorDate = cursorDateText ? new Date(cursorDateText) : null;
    if ((cursorDate && Number.isNaN(cursorDate.getTime())) || (cursorIdText && !isValidObjectId(cursorIdText)) || Boolean(cursorDate) !== Boolean(cursorIdText)) { res.status(400).json({ success: false, message: 'Choose a valid request page cursor.' }); return; }
    const cursorFilter = cursorDate && cursorIdText ? { $or: [{ updatedAt: { $lt: cursorDate } }, { updatedAt: cursorDate, _id: { $lt: new Types.ObjectId(cursorIdText) } }] } : null;
    const queryFilter = cursorFilter ? { ...filter, $and: [...((filter.$and as Record<string, unknown>[] | undefined) || []), cursorFilter] } : filter;
    let tickets = await Ticket.find(queryFilter).populate(populated).sort({ updatedAt: -1, _id: -1 }).limit(limit + 1);
    const hasMore = tickets.length > limit;
    if (hasMore) tickets = tickets.slice(0, limit);
    tickets.forEach(ticket => {
      hideTeamCoordinationFromClient(ticket, req);
      if (req.user!.role === 'agent') {
        hideOtherAgentProposals(ticket, req);
        if (!canAccessConversation(ticket, req)) ticket.set('comments', []);
        if (!canManageAssistanceOffers(ticket, req)) ticket.set('assistanceOffers', (ticket.assistanceOffers || []).filter(offer => referenceId(offer.agent) === req.user!.id));
      }
    });
    const total = await Ticket.countDocuments(filter);
    const last = tickets.at(-1);
    res.json({ success: true, data: { tickets, total, hasMore, nextCursor: hasMore && last ? { beforeDate: last.updatedAt, beforeId: last._id } : null } });
  } catch (error) { next(error); }
});
ticketRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'client') { res.status(403).json({ success: false, message: 'Only client accounts can submit service requests.' }); return; }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    if (parsed.data.submissionId) {
      const existing = await Ticket.findOne({ submissionId: parsed.data.submissionId, clientId: req.user!.id }).select('+submissionId').populate(populated);
      if (existing) { hideTeamCoordinationFromClient(existing, req); res.status(200).json({ success: true, data: { ticket: existing, duplicate: true } }); return; }
    }
    const { submissionId, ...input } = parsed.data;
    const ticket = await Ticket.create({ ...input, ...(submissionId ? { submissionId } : {}), clientId: req.user!.id });
    await ticket.populate(populated);
    const admins = await User.find({ role: 'admin' }).select('_id');
    await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId], action: 'ticket_created', summary: `${req.user!.name} created request “${ticket.title}”`, ticketId: ticket._id, details: { priority: ticket.priority, category: ticket.category }, notification: { type: 'ticket_created', title: 'New client request', message: `${req.user!.name} submitted “${ticket.title}”.`, recipientIds: admins.map(admin => admin._id) } });
    res.status(201).json({ success: true, data: { ticket } });
  } catch (error) { next(error); }
});
ticketRouter.get('/summary', async (req: AuthRequest, res, next) => {
  try {
    const scope = visibleTo(req);
    const active = { status: { $in: ['Open', 'In Progress', 'Ready for review'] } };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const statuses = ['Open', 'In Progress', 'Ready for review', 'Resolved', 'Closed'] as const;
    const [total, ...counts] = await Promise.all([
      Ticket.countDocuments(scope),
      ...statuses.map(status => Ticket.countDocuments({ ...scope, status })),
      Ticket.countDocuments({ ...scope, ...active, assignedTo: null }),
      Ticket.countDocuments({ ...scope, ...active, priority: 'High' }),
      Ticket.countDocuments({ ...scope, ...active, dueDate: { $lt: today } }),
    ]);
    const recent = await Ticket.find(scope).populate(populated).sort({ updatedAt: -1, _id: -1 }).limit(5);
    recent.forEach(ticket => {
      hideTeamCoordinationFromClient(ticket, req);
      if (req.user!.role === 'agent') {
        hideOtherAgentProposals(ticket, req);
        if (!canAccessConversation(ticket, req)) ticket.set('comments', []);
        if (!canManageAssistanceOffers(ticket, req)) ticket.set('assistanceOffers', (ticket.assistanceOffers || []).filter(offer => referenceId(offer.agent) === req.user!.id));
      }
    });
    res.json({ success: true, data: { summary: { total, open: counts[0], inProgress: counts[1], readyForReview: counts[2], resolved: counts[3], closed: counts[4], unassignedActive: counts[5], highPriorityActive: counts[6], overdueActive: counts[7] }, recent } });
  } catch (error) { next(error); }
});

ticketRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    const ticket = await Ticket.findOne({ _id: req.params.id, ...visibleTo(req) }).populate(populated).populate('comments.sender', 'name role avatarUrl').populate('comments.deletedBy', 'name role');
    if (!ticket) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    hideOtherAgentProposals(ticket, req);
    hideTeamCoordinationFromClient(ticket, req);
    if (req.user!.role === 'agent' && !canManageAssistanceOffers(ticket, req)) ticket.set('assistanceOffers', (ticket.assistanceOffers || []).filter(offer => referenceId(offer.agent) === req.user!.id));
    if (!canAccessConversation(ticket, req)) {
      ticket.set('comments', []);
      res.json({ success: true, data: { ticket, messages: [], hasMoreComments: false, hasMoreMessages: false } });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 50);
    const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
    const legacy = ticket.comments as unknown as Array<{ timestamp: Date; [key: string]: unknown }>;
    const commentRows = legacy.filter(comment => !before || new Date(comment.timestamp) < before).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const comments = commentRows.slice(0, limit).reverse();
    const messageFilter = { ticket: ticket._id, ...(before ? { createdAt: { $lt: before } } : {}) };
    const [messages, olderMessages] = await Promise.all([
      ThreadMessage.find(messageFilter).populate('sender', 'name role avatarUrl').populate('deletedBy', 'name role').sort({ createdAt: -1 }).limit(limit).then(items => items.reverse()),
      ThreadMessage.countDocuments(messageFilter),
    ]);
    ticket.set('comments', comments);
    res.json({ success: true, data: { ticket, messages, hasMoreComments: commentRows.length > comments.length, hasMoreMessages: olderMessages > messages.length } });
  } catch (error) { next(error); }
});

const progressInputSchema = z.object({
  summary: z.string().trim().min(5).max(240),
  completed: z.string().trim().max(500).default(''),
  nextAction: z.string().trim().max(300).default(''),
  blockers: z.string().trim().max(300).default(''),
  assistanceNeeded: z.boolean().default(false),
});
ticketRouter.post('/:id/progress', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'agent') { res.status(403).json({ success: false, message: 'Only the assigned agent can update team progress.' }); return; }
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    const parsed = progressInputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    const previous = await Ticket.findOne({ _id: req.params.id, assignedTo: new Types.ObjectId(req.user!.id), status: 'In Progress' }).select('progressUpdates').lean();
    if (!previous) { res.status(409).json({ success: false, message: 'Only the assigned agent can update progress while work is in progress.' }); return; }
    const wasAssistanceNeeded = previous.progressUpdates?.at(-1)?.assistanceNeeded || false;
    const update = { ...parsed.data, author: new Types.ObjectId(req.user!.id), createdAt: new Date() };
    const ticket = await Ticket.findOneAndUpdate(
      { _id: req.params.id, assignedTo: new Types.ObjectId(req.user!.id), status: 'In Progress' },
      { $push: { progressUpdates: { $each: [update], $slice: -50 } } },
      { new: true, runValidators: true },
    ).populate(populated);
    if (!ticket) { res.status(409).json({ success: false, message: 'Only the assigned agent can update progress while work is in progress.' }); return; }
    await trackEvent({ actorId: req.user!.id, participantIds: [req.user!.id], action: 'progress_updated', summary: `${req.user!.name} updated the team progress on “${ticket.title}”`, ticketId: ticket._id, details: { status: ticket.status, assistanceNeeded: update.assistanceNeeded } });
    if (update.assistanceNeeded && !wasAssistanceNeeded) {
      const admins = await User.find({ role: 'admin', isBanned: { $ne: true } }).select('_id');
      const alerts = await Promise.allSettled(admins.map(admin => Notification.findOneAndUpdate(
        { recipient: admin._id, ticket: ticket._id, type: 'blocker_attention' },
        { $set: { actor: req.user!.id, title: 'A request needs team attention', message: `An agent flagged a blocker on “${ticket.title}”. Review its team progress.`, link: `/tickets/${ticket._id}`, readAt: null }, $setOnInsert: { recipient: admin._id, ticket: ticket._id, type: 'blocker_attention' } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )));
      for (const alert of alerts) if (alert.status === 'rejected') console.error('Failed to persist a team blocker notification:', alert.reason);
    }
    res.json({ success: true, data: { ticket } });
  } catch (error) { next(error); }
});

const assistanceOfferInputSchema = z.object({ message: z.string().trim().min(10).max(500) });
ticketRouter.post('/:id/assistance-offers', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'agent') { res.status(403).json({ success: false, message: 'Only agents can offer team assistance.' }); return; }
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    const parsed = assistanceOfferInputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    const ticket = await Ticket.findOneAndUpdate(
      { _id: req.params.id, status: 'In Progress', assignedTo: { $exists: true, $nin: [null, new Types.ObjectId(req.user!.id)] }, assistanceOffers: { $not: { $elemMatch: { agent: new Types.ObjectId(req.user!.id), status: 'pending' } } } },
      { $push: { assistanceOffers: { $each: [{ agent: new Types.ObjectId(req.user!.id), message: parsed.data.message, status: 'pending', createdAt: new Date() }], $slice: -50 } } },
      { new: true, runValidators: true },
    ).populate(populated);
    if (!ticket) { res.status(409).json({ success: false, message: 'This request cannot accept your offer, or you already have a pending offer.' }); return; }
    const ownerId = (ticket.assignedTo as unknown as { _id?: Types.ObjectId })?._id?.toString() || ticket.assignedTo?.toString();
    if (!ownerId) { res.status(409).json({ success: false, message: 'This request no longer has an assigned owner.' }); return; }
    ticket.set('assistanceOffers', ticket.assistanceOffers.filter(offer => referenceId(offer.agent) === req.user!.id));
    await trackEvent({ actorId: req.user!.id, participantIds: [ownerId], action: 'assistance_offered', summary: `${req.user!.name} offered help on “${ticket.title}”`, ticketId: ticket._id, details: { status: 'pending' }, notification: { type: 'assistance_offer', title: 'An agent offered help', message: `${req.user!.name} offered assistance on “${ticket.title}”.`, recipientIds: [ownerId], link: `/tickets/${ticket._id}` } });
    res.status(201).json({ success: true, data: { ticket } });
  } catch (error) { next(error); }
});

ticketRouter.patch('/:id/assistance-offers/:offerId', async (req: AuthRequest, res, next) => {
  try {
    if (!['agent', 'admin'].includes(req.user!.role)) { res.status(403).json({ success: false, message: 'Only the assigned agent or an admin can respond to an assistance offer.' }); return; }
    if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.offerId)) { res.status(404).json({ success: false, message: 'Assistance offer not found.' }); return; }
    const parsed = z.object({ status: z.enum(['accepted', 'declined']) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Choose whether to accept or decline this offer.' }); return; }
    const accessFilter = req.user!.role === 'admin' ? {} : { assignedTo: new Types.ObjectId(req.user!.id) };
    const current = await Ticket.findById(req.params.id).select('assignedTo');
    const acceptedFor = referenceId(current?.assignedTo);
    if (!acceptedFor) { res.status(409).json({ success: false, message: 'Assign an agent before accepting an assistance offer.' }); return; }
    if (req.user!.role === 'agent' && acceptedFor !== req.user!.id) { res.status(409).json({ success: false, message: 'Only the assigned agent can decide this offer.' }); return; }
    const ticket = await Ticket.findOneAndUpdate(
      { _id: req.params.id, ...accessFilter, assignedTo: new Types.ObjectId(acceptedFor), assistanceOffers: { $elemMatch: { _id: new Types.ObjectId(req.params.offerId), status: 'pending' } } },
      { $set: { 'assistanceOffers.$.status': parsed.data.status, 'assistanceOffers.$.respondedAt': new Date(), 'assistanceOffers.$.respondedBy': new Types.ObjectId(req.user!.id), 'assistanceOffers.$.acceptedFor': parsed.data.status === 'accepted' ? new Types.ObjectId(acceptedFor) : null } },
      { new: true, runValidators: true },
    ).populate(populated);
    if (!ticket) { res.status(409).json({ success: false, message: 'This offer is no longer pending or you are not authorized to manage it.' }); return; }
    const offer = ticket.assistanceOffers.find(item => item._id?.toString() === req.params.offerId);
    if (!offer) { res.status(404).json({ success: false, message: 'Assistance offer not found.' }); return; }
    const offerAgentId = (offer.agent as unknown as { _id?: Types.ObjectId })._id?.toString() || offer.agent.toString();
    const verb = parsed.data.status === 'accepted' ? 'accepted' : 'declined';
    await trackEvent({ actorId: req.user!.id, participantIds: [offerAgentId, referenceId(ticket.assignedTo)], action: 'assistance_offer_decided', summary: `${req.user!.name} ${verb} an assistance offer for “${ticket.title}”`, ticketId: ticket._id, details: { offerId: req.params.offerId, status: parsed.data.status }, notification: { type: 'assistance_offer', title: `Assistance offer ${verb}`, message: parsed.data.status === 'accepted' ? `Your help on “${ticket.title}” was accepted. You can now join its private team discussion.` : `Your offer for “${ticket.title}” was declined.`, recipientIds: [offerAgentId], link: `/tickets/${ticket._id}` } });
    res.json({ success: true, data: { ticket } });
  } catch (error) { next(error); }
});

const teamMessageSchema = z.object({ message: z.string().trim().min(1).max(2000) });
ticketRouter.get('/:id/team-messages', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    const ticket = await Ticket.findById(req.params.id).select('assignedTo assistanceOffers');
    if (!ticket) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    if (!canAccessTeamThread(ticket, req)) { res.status(403).json({ success: false, message: 'This private team discussion is only available to the assigned agent, accepted helpers, and admins.' }); return; }
    const messages = await TeamMessage.find({ ticket: ticket._id }).populate('sender', 'name role avatarUrl').sort({ createdAt: -1, _id: -1 }).limit(50).then(rows => rows.reverse());
    res.json({ success: true, data: { messages } });
  } catch (error) { next(error); }
});
ticketRouter.post('/:id/team-messages', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    const parsed = teamMessageSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    const ticket = await Ticket.findById(req.params.id).select('title assignedTo assistanceOffers');
    if (!ticket) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    if (!canAccessTeamThread(ticket, req)) { res.status(403).json({ success: false, message: 'This private team discussion is only available to the assigned agent, accepted helpers, and admins.' }); return; }
    const message = await TeamMessage.create({ ticket: ticket._id, sender: new Types.ObjectId(req.user!.id), message: parsed.data.message });
    await message.populate('sender', 'name role avatarUrl');
    const recipients = activeTeamMemberIds(ticket).filter(id => id !== req.user!.id);
    await trackEvent({ actorId: req.user!.id, participantIds: activeTeamMemberIds(ticket), action: 'team_message_sent', summary: `${req.user!.name} sent a private team message on “${ticket.title}”`, ticketId: ticket._id, details: { messageId: message._id }, notification: { type: 'team_message', title: 'New team message', message: `A teammate added a message to “${ticket.title}”.`, recipientIds: recipients, link: `/tickets/${ticket._id}` } });
    res.status(201).json({ success: true, data: { message } });
  } catch (error) { next(error); }
});
ticketRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    if (req.user!.role === 'client') {
      const clientSchema = z.object({ title: z.string().trim().min(4).max(140), description: z.string().trim().min(10).max(10000), category: z.string().trim().min(2).max(60), priority: z.enum(priorities) });
      const clientParsed = clientSchema.safeParse(req.body);
      if (!clientParsed.success) { res.status(400).json({ success: false, message: clientParsed.error.issues[0].message }); return; }
      const ticket = await Ticket.findOne({ _id: req.params.id, clientId: req.user!.id });
      if (!ticket) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
      if (ticket.status !== 'Open') { res.status(409).json({ success: false, message: 'Requests can only be edited while they are open.' }); return; }
      const changedFields = (['title', 'description', 'category', 'priority'] as const).filter(field => ticket[field] !== clientParsed.data[field]);
      if (changedFields.length) {
        Object.assign(ticket, clientParsed.data);
        await ticket.save();
        await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId, ...(ticket.assignedTo ? [ticket.assignedTo] : [])], action: 'request_edited', summary: `${req.user!.name} edited request “${ticket.title}”`, ticketId: ticket._id, details: { fields: changedFields } });
      }
      await ticket.populate(populated);
      hideTeamCoordinationFromClient(ticket, req);
      res.json({ success: true, data: { ticket } });
      return;
    }
    if (req.user!.role !== 'admin' && req.user!.role !== 'agent') { res.status(403).json({ success: false, message: 'Only the request owner or agency staff can edit this request.' }); return; }
    const schema = z.object({ status: z.enum(statuses).optional(), priority: z.enum(priorities).optional(), assignedTo: z.string().nullable().optional(), dueDate: z.string().date().nullable().optional() }).refine(v => Object.keys(v).length > 0);
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Provide a valid status, priority, or assignee.' }); return; }
    if (req.user!.role === 'agent' && parsed.data.priority !== undefined) { res.status(403).json({ success: false, message: 'Only the client or an admin can change request priority.' }); return; }
    if (req.user!.role === 'agent' && parsed.data.assignedTo !== undefined) { res.status(403).json({ success: false, message: 'Submit a response first. The client chooses which agent to assign.' }); return; }
    if (req.user!.role !== 'admin' && parsed.data.assignedTo !== undefined) { res.status(403).json({ success: false, message: 'Only an admin can change the assigned agent.' }); return; }
    if (req.user!.role === 'agent' && (parsed.data.status === 'Closed' || parsed.data.status === 'Open')) { res.status(403).json({ success: false, message: 'Agents can move assigned work forward or send it for client review.' }); return; }
    if (!canSetTicketStatusDirectly(req.user!.role, parsed.data.status)) { res.status(403).json({ success: false, message: parsed.data.status === 'Ready for review' ? 'Requests can only enter client review through the assigned agent’s delivery handoff.' : 'Only the client can confirm resolution after reviewing the work.' }); return; }
    if (parsed.data.assignedTo && (!isValidObjectId(parsed.data.assignedTo) || !(await User.exists({ _id: parsed.data.assignedTo, role: 'agent', approvalStatus: 'approved', isBanned: { $ne: true } })))) { res.status(400).json({ success: false, message: 'Assignee must be an approved, active agent.' }); return; }
    let ticket = await Ticket.findOne({ _id: req.params.id, ...visibleTo(req) });
    if (!ticket) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    if (parsed.data.assignedTo !== undefined && !canChangeAssignee(req.user!.role, ticket.status)) { res.status(409).json({ success: false, message: 'The assigned agent cannot change during client review. The client must request changes first.' }); return; }
    if (ticket.status === 'Ready for review' && (parsed.data.status === 'In Progress' || parsed.data.status === 'Open')) { res.status(409).json({ success: false, message: 'The client controls whether reviewed work needs changes.' }); return; }
    if (req.user!.role === 'agent' && ticket.assignedTo?.toString() !== req.user!.id) { res.status(403).json({ success: false, message: 'Only the agent assigned to this request can update its work status.' }); return; }
    if (req.user!.role === 'agent' && parsed.data.status === 'In Progress' && ticket.status !== 'Open' && ticket.status !== 'In Progress') { res.status(409).json({ success: false, message: 'Only the client can return work from review, resolution, or closure to In Progress.' }); return; }
    const previous = { status: ticket.status, priority: ticket.priority, assignedTo: ticket.assignedTo?.toString() || null, dueDate: ticket.dueDate ? ticket.dueDate.toISOString().slice(0, 10) : null };
    Object.assign(ticket, parsed.data, parsed.data.dueDate !== undefined ? { dueDate: parsed.data.dueDate ? new Date(`${parsed.data.dueDate}T00:00:00.000Z`) : null } : {});
    await ticket.save();
    const statusChanged = previous.status !== ticket.status;
    const priorityChanged = previous.priority !== ticket.priority;
    const assignedTo = ticket.assignedTo?.toString() || null;
    const assigneeChanged = previous.assignedTo !== assignedTo;
    const dueDate = ticket.dueDate ? ticket.dueDate.toISOString().slice(0, 10) : null;
    const dueDateChanged = previous.dueDate !== dueDate;
    const eventParticipants = [ticket.clientId, ...(assignedTo ? [assignedTo] : []), ...(previous.assignedTo ? [previous.assignedTo] : [])];
    if (statusChanged) await trackEvent({ actorId: req.user!.id, participantIds: eventParticipants, action: 'status_changed', summary: `${req.user!.name} changed “${ticket.title}” from ${previous.status} to ${ticket.status}`, ticketId: ticket._id, details: { from: previous.status, to: ticket.status }, notification: { type: 'status_changed', title: 'Request status updated', message: `“${ticket.title}” is now ${ticket.status}.`, recipientIds: [ticket.clientId, ...(assignedTo ? [assignedTo] : [])] } });
    if (priorityChanged) await trackEvent({ actorId: req.user!.id, participantIds: eventParticipants, action: 'priority_changed', summary: `${req.user!.name} changed the priority of “${ticket.title}” from ${previous.priority} to ${ticket.priority}`, ticketId: ticket._id, details: { from: previous.priority, to: ticket.priority } });
    if (assigneeChanged) await trackEvent({ actorId: req.user!.id, participantIds: eventParticipants, action: 'assignee_changed', summary: `${req.user!.name} ${assignedTo ? 'assigned' : 'unassigned'} “${ticket.title}”${assignedTo ? ` to ${(await User.findById(assignedTo).select('name'))?.name || 'an agency member'}` : ''}`, ticketId: ticket._id, details: { from: previous.assignedTo, to: assignedTo }, notification: { type: 'assignee_changed', title: 'Request assignment changed', message: `The assignment for “${ticket.title}” changed. Check the request board to see who owns it.`, recipientIds: [ticket.clientId, ...(assignedTo ? [assignedTo] : []), ...(previous.assignedTo ? [previous.assignedTo] : [])] } });
    if (dueDateChanged) await trackEvent({ actorId: req.user!.id, participantIds: eventParticipants, action: 'due_date_changed', summary: `${req.user!.name} ${dueDate ? `set the due date for “${ticket.title}” to ${dueDate}` : `cleared the due date for “${ticket.title}”`}`, ticketId: ticket._id, details: { from: previous.dueDate, to: dueDate } });
    await ticket.populate(populated);
    hideOtherAgentProposals(ticket, req);
    hideTeamCoordinationFromClient(ticket, req);
    res.json({ success: true, data: { ticket } });
  } catch (error) { next(error); }
});

ticketRouter.post('/:id/submit-review', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'agent') { res.status(403).json({ success: false, message: 'Only the assigned agent can send work for client review.' }); return; }
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    const parsed = workReviewSubmissionSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    for (const attachment of [parsed.data.attachment, ...(parsed.data.attachments || [])].filter(Boolean)) { const attachmentError = validateAttachment(attachment!); if (attachmentError) { res.status(400).json({ success: false, message: attachmentError }); return; } }
    const ticket = await Ticket.findOne({ _id: req.params.id, assignedTo: req.user!.id, status: { $in: ['In Progress', 'Ready for review'] } });
    if (!ticket) { res.status(409).json({ success: false, message: 'Only your assigned request while in progress can be sent for review.' }); return; }
    let message = await ThreadMessage.findOne({ submissionId: parsed.data.submissionId, ticket: ticket._id, sender: req.user!.id }).select('+submissionId');
    let insertedByThisRequest = false;
    if (!message) {
      if (ticket.status === 'Ready for review') { res.status(409).json({ success: false, message: 'This request is already awaiting client review. Refresh the page to see its submission.' }); return; }
      try {
        message = await ThreadMessage.create({ ticket: ticket._id, sender: req.user!.id, message: parsed.data.message, attachment: parsed.data.attachment, attachments: parsed.data.attachments, submissionId: parsed.data.submissionId });
        insertedByThisRequest = true;
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        message = await ThreadMessage.findOne({ submissionId: parsed.data.submissionId, ticket: ticket._id, sender: req.user!.id }).select('+submissionId') as NonNullable<typeof message>;
        if (!message) throw error;
      }
    }
    if (ticket.status !== 'Ready for review') {
      const previousStatus = ticket.status;
      const transitioned = await Ticket.findOneAndUpdate(
        { _id: ticket._id, assignedTo: req.user!.id, status: 'In Progress' },
        { $set: { status: 'Ready for review', workCompletedBy: new Types.ObjectId(req.user!.id), workCompletedAt: new Date(), creditedAgent: null, resolutionConfirmedBy: null, resolutionConfirmedAt: null } },
        { new: true, runValidators: true },
      );
      if (!transitioned) {
        const latest = await Ticket.findById(ticket._id);
        if (latest?.status === 'Ready for review' && !insertedByThisRequest) {
          await Promise.all([latest.populate(populated), message.populate('sender', 'name role avatarUrl')]);
          hideOtherAgentProposals(latest, req);
          res.status(200).json({ success: true, data: { ticket: latest, message } });
          return;
        }
        if (insertedByThisRequest) await ThreadMessage.deleteOne({ _id: message._id, ticket: ticket._id, sender: req.user!.id });
        res.status(409).json({ success: false, message: 'The request changed while you were sending the handoff. Refresh and try again.' });
        return;
      }
      ticket.overwrite(transitioned.toObject());
      const participants = [ticket.clientId, req.user!.id];
      await trackEvent({ actorId: req.user!.id, participantIds: participants, action: 'status_changed', summary: `${req.user!.name} changed “${ticket.title}” from ${previousStatus} to Ready for review`, ticketId: ticket._id, details: { from: previousStatus, to: 'Ready for review' } });
      await trackEvent({ actorId: req.user!.id, participantIds: participants, action: 'work_ready_for_review', summary: `${req.user!.name} sent “${ticket.title}” for client review with a delivery note`, ticketId: ticket._id, details: { workCompletedBy: req.user!.id, workCompletedAt: ticket.workCompletedAt?.toISOString() || null, attachmentName: message.attachment?.name || null }, notification: { type: 'status_changed', title: 'Work is ready for review', message: `${req.user!.name} sent “${ticket.title}” for your review with a delivery note.`, recipientIds: [ticket.clientId] } });
    }
    await Promise.all([ticket.populate(populated), message.populate('sender', 'name role avatarUrl')]);
    hideOtherAgentProposals(ticket, req);
    res.status(200).json({ success: true, data: { ticket, message } });
  } catch (error) { next(error); }
});

ticketRouter.post('/:id/proposals', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'agent') { res.status(403).json({ success: false, message: 'Only agents can respond to an open request.' }); return; }
    const parsed = z.object({ message: z.string().trim().min(10).max(1000) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Write at least 10 characters explaining how you can help.' }); return; }
    const ticket = await Ticket.findOne({ _id: req.params.id, status: 'Open', assignedTo: null, clientId: { $ne: req.user!.id } });
    if (!ticket) { res.status(409).json({ success: false, message: 'This request is no longer accepting agent responses.' }); return; }
    const existing = ticket.proposals.find(proposal => proposal.agent.toString() === req.user!.id);
    const responseAction = existing ? 'updated' : 'created';
    if (existing && (existing.updateCount || 0) >= MAX_AGENT_RESPONSE_UPDATES) { res.status(429).json({ success: false, message: `You have reached the limit of ${MAX_AGENT_RESPONSE_UPDATES} response updates for this request.` }); return; }
    const submittedAt = new Date();
    const writeResult = existing
      ? await Ticket.updateOne({
        _id: ticket._id,
        status: 'Open',
        assignedTo: null,
        proposals: { $elemMatch: { agent: req.user!.id, $or: [{ updateCount: { $lt: MAX_AGENT_RESPONSE_UPDATES } }, { updateCount: { $exists: false } }] } },
      }, { $set: { 'proposals.$.message': parsed.data.message, 'proposals.$.createdAt': submittedAt }, $inc: { 'proposals.$.updateCount': 1 } })
      : await Ticket.updateOne({ _id: ticket._id, status: 'Open', assignedTo: null, 'proposals.agent': { $ne: req.user!.id } }, {
        $push: { proposals: { agent: new Types.ObjectId(req.user!.id), message: parsed.data.message, createdAt: submittedAt, updateCount: 0 } },
      });
    if (!writeResult.modifiedCount) {
      const current = await Ticket.findById(ticket._id).select('status assignedTo proposals');
      const currentProposal = current?.proposals.find(proposal => proposal.agent.toString() === req.user!.id);
      if (currentProposal && (currentProposal.updateCount || 0) >= MAX_AGENT_RESPONSE_UPDATES) { res.status(429).json({ success: false, message: `You have reached the limit of ${MAX_AGENT_RESPONSE_UPDATES} response updates for this request.` }); return; }
      res.status(409).json({ success: false, message: 'This request changed while you were responding. Refresh it and try again.' });
      return;
    }
    await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId], action: 'agent_proposed', summary: `${req.user!.name} ${responseAction} a response to “${ticket.title}”`, ticketId: ticket._id });
    await Notification.findOneAndUpdate(
      { recipient: ticket.clientId, actor: req.user!.id, ticket: ticket._id, type: 'agent_proposal' },
      { $set: { title: responseAction === 'updated' ? 'An agent updated their response' : 'An agent responded to your request', message: `${req.user!.name} ${responseAction === 'updated' ? 'updated their approach for' : 'is available to help with'} “${ticket.title}”.`, link: `/tickets/${ticket._id}`, readAt: null }, $setOnInsert: { recipient: ticket.clientId, actor: req.user!.id, ticket: ticket._id, type: 'agent_proposal' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const updatedTicket = await Ticket.findById(ticket._id).populate(populated);
    if (!updatedTicket) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    const updatedProposal = updatedTicket.proposals.find(proposal => proposal.agent.toString() === req.user!.id);
    hideOtherAgentProposals(updatedTicket, req);
    res.json({ success: true, data: { ticket: updatedTicket, responseAction, updatesRemaining: MAX_AGENT_RESPONSE_UPDATES - (updatedProposal?.updateCount || 0) } });
  } catch (error) { next(error); }
});

ticketRouter.post('/:id/accept-proposal', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'client') { res.status(403).json({ success: false, message: 'Only the client who created this request can choose an agent.' }); return; }
    const parsed = z.object({ agentId: z.string().refine(isValidObjectId, 'Choose a valid agent.') }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    const ticket = await Ticket.findOne({ _id: req.params.id, clientId: req.user!.id, status: 'Open', assignedTo: null });
    if (!ticket) { res.status(409).json({ success: false, message: 'This request is no longer available for agent selection.' }); return; }
    if (!ticket.proposals.some(proposal => proposal.agent.toString() === parsed.data.agentId)) { res.status(404).json({ success: false, message: 'That agent has not responded to this request.' }); return; }
    const assigned = await Ticket.findOneAndUpdate({ _id: ticket._id, clientId: req.user!.id, status: 'Open', assignedTo: null, 'proposals.agent': new Types.ObjectId(parsed.data.agentId) }, { $set: { assignedTo: parsed.data.agentId, status: 'In Progress' } }, { new: true });
    if (!assigned) { res.status(409).json({ success: false, message: 'Another assignment was just made. Refresh the request and try again.' }); return; }
    const agent = await User.findById(parsed.data.agentId).select('name');
    await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId, parsed.data.agentId], action: 'assignee_changed', summary: `${req.user!.name} chose ${agent?.name || 'an agent'} to work on “${ticket.title}”`, ticketId: ticket._id, details: { from: null, to: parsed.data.agentId, chosenByClient: true }, notification: { type: 'assignee_changed', title: 'Your response was selected', message: `${req.user!.name} selected you to work on “${ticket.title}”.`, recipientIds: [parsed.data.agentId] } });
    await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId, parsed.data.agentId], action: 'status_changed', summary: `Work on “${ticket.title}” started with ${agent?.name || 'the selected agent'}`, ticketId: ticket._id, details: { from: 'Open', to: 'In Progress', chosenByClient: true } });
    await assigned.populate(populated);
    hideOtherAgentProposals(assigned, req);
    hideTeamCoordinationFromClient(assigned, req);
    res.json({ success: true, data: { ticket: assigned } });
  } catch (error) { next(error); }
});

ticketRouter.post('/:id/cancel-work', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'agent') { res.status(403).json({ success: false, message: 'Only the assigned agent can cancel their work.' }); return; }
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    const current = await Ticket.findOne({ _id: req.params.id, assignedTo: new Types.ObjectId(req.user!.id), status: { $in: ['Open', 'In Progress'] } }).select('status');
    if (!current) { res.status(409).json({ success: false, message: 'You can cancel only your own assigned request while it is open or in progress. Requests awaiting client review must first be returned for changes.' }); return; }
    const ticket = await Ticket.findOneAndUpdate(
      { _id: req.params.id, assignedTo: new Types.ObjectId(req.user!.id), status: current.status },
      { $set: { assignedTo: null, status: 'Open', workCompletedBy: null, workCompletedAt: null, creditedAgent: null, resolutionConfirmedBy: null, resolutionConfirmedAt: null }, $pull: { proposals: { agent: new Types.ObjectId(req.user!.id) } } },
      { new: true },
    );
    if (!ticket) { res.status(409).json({ success: false, message: 'This request changed before cancellation completed. Refresh it and try again.' }); return; }
    const admins = await User.find({ role: 'admin', isBanned: { $ne: true } }).select('_id');
    const participants = [ticket.clientId, req.user!.id];
    await trackEvent({ actorId: req.user!.id, participantIds: participants, action: 'assignee_changed', summary: `${req.user!.name} cancelled their work on “${ticket.title}”`, ticketId: ticket._id, details: { from: req.user!.id, to: null, reason: 'agent_cancelled_work' }, notification: { type: 'assignee_changed', title: 'Agent released your request', message: `${req.user!.name} can no longer work on “${ticket.title}”. It is open for another agent to respond.`, recipientIds: [ticket.clientId] } });
    if (current.status !== 'Open') await trackEvent({ actorId: req.user!.id, participantIds: participants, action: 'status_changed', summary: `${req.user!.name} returned “${ticket.title}” to the open queue`, ticketId: ticket._id, details: { from: current.status, to: 'Open', reason: 'agent_cancelled_work' }, notification: { type: 'status_changed', title: 'Request is available again', message: `“${ticket.title}” is open for another agent to respond.`, recipientIds: admins.map(admin => admin._id) } });
    await ticket.populate(populated);
    hideOtherAgentProposals(ticket, req);
    hideTeamCoordinationFromClient(ticket, req);
    res.json({ success: true, data: { ticket } });
  } catch (error) { next(error); }
});

ticketRouter.post('/:id/comments', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    const parsed = threadMessageInputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    for (const attachment of [parsed.data.attachment, ...(parsed.data.attachments || [])].filter(Boolean)) { const attachmentError = validateAttachment(attachment!); if (attachmentError) { res.status(400).json({ success: false, message: attachmentError }); return; } }
    const ticket = await Ticket.findOne({ _id: req.params.id, ...visibleTo(req) });
    if (!ticket) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    if (!canAccessConversation(ticket, req)) { res.status(403).json({ success: false, message: 'Only the client, assigned agent, or an admin can access this request conversation.' }); return; }
    if (parsed.data.submissionId) {
      const existing = await ThreadMessage.findOne({ submissionId: parsed.data.submissionId, ticket: ticket._id, sender: req.user!.id }).select('+submissionId').populate('sender', 'name role avatarUrl');
      if (existing) { res.status(200).json({ success: true, data: { message: existing, duplicate: true } }); return; }
    }
    const message = await ThreadMessage.create({ ticket: ticket._id, sender: req.user!.id, message: parsed.data.message, attachment: parsed.data.attachment, attachments: parsed.data.attachments, ...(parsed.data.submissionId ? { submissionId: parsed.data.submissionId } : {}) });
    const candidateRecipients = req.user!.role !== 'client' ? [ticket.clientId] : ticket.assignedTo ? [ticket.assignedTo] : [];
    // Conversation comments are useful to the other participants, but are not admin-level alerts.
    // Exclude admins even when one is assigned to the request.
    const recipients = (await User.find({ _id: { $in: candidateRecipients }, role: { $ne: 'admin' } }).select('_id')).map(member => member._id);
    await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId, ...(ticket.assignedTo ? [ticket.assignedTo] : [])], action: 'comment_added', summary: `${req.user!.name} added to the conversation on “${ticket.title}”`, ticketId: ticket._id, ...(recipients.length ? { notification: { type: 'comment_added' as const, title: 'New request comment', message: `${req.user!.name} commented on “${ticket.title}”.`, recipientIds: recipients } } : {}) });
    await message.populate('sender', 'name role avatarUrl');
    res.status(201).json({ success: true, data: { message } });
  } catch (error) { next(error); }
});

ticketRouter.delete('/:id/messages/:messageId', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.messageId)) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const ticket = await Ticket.findOne({ _id: req.params.id, ...visibleTo(req) });
    if (!ticket) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    if (!canAccessConversation(ticket, req)) { res.status(403).json({ success: false, message: 'Only the client, assigned agent, or an admin can access this request conversation.' }); return; }
    const threadMessage = await ThreadMessage.findOne({ _id: req.params.messageId, ticket: ticket._id });
    if (threadMessage) {
      if (threadMessage.sender.toString() !== req.user!.id && req.user!.role !== 'admin') { res.status(403).json({ success: false, message: 'You can delete only your own messages.' }); return; }
      if (!threadMessage.deletedAt) { threadMessage.deletedAt = new Date(); threadMessage.deletedBy = new Types.ObjectId(req.user!.id); threadMessage.message = ''; threadMessage.attachment = undefined; threadMessage.attachments = []; await threadMessage.save(); }
    } else {
      const legacyComments = ticket.get('comments') as unknown as Array<{ _id: { toString(): string }; sender: { toString(): string }; deletedBy?: string }>;
      const legacyComment = legacyComments.find(comment => comment._id.toString() === req.params.messageId);
      if (!legacyComment) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
      if (legacyComment.sender.toString() !== req.user!.id && req.user!.role !== 'admin') { res.status(403).json({ success: false, message: 'You can delete only your own messages.' }); return; }
      Object.assign(legacyComment, { message: '', deletedAt: new Date(), deletedBy: req.user!.id });
      ticket.set('comments', legacyComments);
      await ticket.save();
    }
    await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId, ...(ticket.assignedTo ? [ticket.assignedTo] : [])], action: 'message_deleted', summary: `${req.user!.name} deleted a message from “${ticket.title}”`, ticketId: ticket._id });
    res.json({ success: true, data: { deleted: true } });
  } catch (error) { next(error); }
});

ticketRouter.post('/:id/messages/:messageId/reactions', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.messageId)) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const parsed = z.object({ emoji: z.enum(reactionEmojis) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Choose a supported reaction.' }); return; }
    const ticket = await Ticket.findOne({ _id: req.params.id, ...visibleTo(req) });
    if (!ticket) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    if (!canAccessConversation(ticket, req)) { res.status(403).json({ success: false, message: 'Only the client, assigned agent, or an admin can access this request conversation.' }); return; }
    const threadMessage = await ThreadMessage.findOne({ _id: req.params.messageId, ticket: ticket._id, deletedAt: { $exists: false } });
    let reactions: Array<{ user: Types.ObjectId; emoji: string }>;
    if (threadMessage) {
      reactions = threadMessage.reactions as Array<{ user: Types.ObjectId; emoji: string }>;
      const index = reactions.findIndex(reaction => String(reaction.user) === req.user!.id);
      if (index >= 0 && reactions[index].emoji === parsed.data.emoji) reactions.splice(index, 1);
      else if (index >= 0) reactions[index].emoji = parsed.data.emoji;
      else reactions.push({ user: new Types.ObjectId(req.user!.id), emoji: parsed.data.emoji as typeof reactionEmojis[number] });
      await threadMessage.save();
    } else {
      const comments = ticket.get('comments') as unknown as Array<{ _id: { toString(): string }; deletedAt?: Date; reactions?: Array<{ user: Types.ObjectId; emoji: string }> }>;
      const comment = comments.find(item => item._id.toString() === req.params.messageId && !item.deletedAt);
      if (!comment) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
      comment.reactions ||= [];
      const index = comment.reactions.findIndex(reaction => String(reaction.user) === req.user!.id);
      if (index >= 0 && comment.reactions[index].emoji === parsed.data.emoji) comment.reactions.splice(index, 1);
      else if (index >= 0) comment.reactions[index].emoji = parsed.data.emoji;
      else comment.reactions.push({ user: new Types.ObjectId(req.user!.id), emoji: parsed.data.emoji });
      ticket.set('comments', comments);
      await ticket.save();
      reactions = comment.reactions;
    }
    res.json({ success: true, data: { reactions: reactions.map(reaction => ({ user: String(reaction.user), emoji: reaction.emoji })) } });
  } catch (error) { next(error); }
});

ticketRouter.patch('/:id/messages/:messageId', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.messageId)) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const parsed = z.object({ message: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Message text must be between 1 and 2000 characters.' }); return; }
    const ticket = await Ticket.findOne({ _id: req.params.id, ...visibleTo(req) });
    if (!ticket) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    if (!canAccessConversation(ticket, req)) { res.status(403).json({ success: false, message: 'Only the client, assigned agent, or an admin can access this request conversation.' }); return; }
    const threadMessage = await ThreadMessage.findOne({ _id: req.params.messageId, ticket: ticket._id, deletedAt: { $exists: false } });
    if (threadMessage) {
      if (threadMessage.sender.toString() !== req.user!.id) { res.status(403).json({ success: false, message: 'You can edit only your own messages.' }); return; }
      threadMessage.message = parsed.data.message;
      threadMessage.editedAt = new Date();
      await threadMessage.save();
    } else {
      const comments = ticket.get('comments') as unknown as Array<{ _id: { toString(): string }; sender: { toString(): string }; deletedAt?: Date; message: string; editedAt?: Date }>;
      const comment = comments.find(item => item._id.toString() === req.params.messageId && !item.deletedAt);
      if (!comment) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
      if (comment.sender.toString() !== req.user!.id) { res.status(403).json({ success: false, message: 'You can edit only your own messages.' }); return; }
      comment.message = parsed.data.message;
      comment.editedAt = new Date();
      ticket.set('comments', comments);
      await ticket.save();
    }
    await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId, ...(ticket.assignedTo ? [ticket.assignedTo] : [])], action: 'message_edited', summary: `${req.user!.name} edited a message on “${ticket.title}”`, ticketId: ticket._id });
    res.json({ success: true, data: { edited: true } });
  } catch (error) { next(error); }
});

ticketRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'admin' && req.user!.role !== 'client') { res.status(403).json({ success: false, message: 'Only the request owner or an admin can delete this request.' }); return; }
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    const ticket = await Ticket.findOne({ _id: req.params.id, ...(req.user!.role === 'client' ? { clientId: req.user!.id } : {}) });
    if (!ticket) { res.status(404).json({ success: false, message: 'Request not found.' }); return; }
    const participants = [ticket.clientId, ...(ticket.assignedTo ? [ticket.assignedTo] : [])];
    await Promise.all([ThreadMessage.deleteMany({ ticket: ticket._id }), TeamMessage.deleteMany({ ticket: ticket._id }), Notification.deleteMany({ ticket: ticket._id }), ticket.deleteOne()]);
    await trackEvent({ actorId: req.user!.id, participantIds: participants, action: 'request_deleted', summary: `${req.user!.name} deleted request “${ticket.title}”`, details: { ticketId: ticket.id } });
    res.json({ success: true, data: { deleted: true } });
  } catch (error) { next(error); }
});

ticketRouter.patch('/:id/resolve', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'client') { res.status(403).json({ success: false, message: 'Only clients can resolve their own requests.' }); return; }
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    let ticket = await Ticket.findOne({ _id: req.params.id, clientId: req.user!.id });
    if (!ticket) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    if (ticket.status !== 'Ready for review') { res.status(409).json({ success: false, message: 'The agency must mark this request ready before you can confirm it.' }); return; }
    const feedbackInput = z.object({ rating: z.number().int().min(1).max(5).optional() }).safeParse(req.body || {});
    if (!feedbackInput.success) { res.status(400).json({ success: false, message: 'Choose a rating from 1 to 5 stars.' }); return; }
    const resolved = await Ticket.findOneAndUpdate(
      { _id: ticket._id, clientId: req.user!.id, status: 'Ready for review' },
      { $set: { status: 'Resolved', resolutionConfirmedBy: new Types.ObjectId(req.user!.id), resolutionConfirmedAt: new Date(), creditedAgent: ticket.workCompletedBy || null, ...(feedbackInput.data.rating ? { agentRating: feedbackInput.data.rating } : {}) }, ...(feedbackInput.data.rating ? {} : { $unset: { agentRating: 1 } }) },
      { new: true, runValidators: true },
    );
    if (!resolved) { res.status(409).json({ success: false, message: 'The request changed before it could be confirmed. Refresh and try again.' }); return; }
    ticket = resolved;
    const admins = await User.find({ role: 'admin' }).select('_id');
    await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId, ...(ticket.assignedTo ? [ticket.assignedTo] : [])], action: 'client_resolved', summary: `${req.user!.name} confirmed “${ticket.title}” as resolved`, ticketId: ticket._id, details: { status: 'Resolved', ticketTitle: ticket.title, ticketCategory: ticket.category, clientName: req.user!.name, workCompletedBy: ticket.workCompletedBy?.toString() || null, creditedAgent: ticket.creditedAgent?.toString() || null, agentRating: ticket.agentRating ?? null, resolutionConfirmedBy: req.user!.id }, notification: { type: 'status_changed', title: 'Client confirmed the work', message: `“${ticket.title}” was confirmed as resolved by ${req.user!.name}.`, recipientIds: [...admins.map(admin => admin._id), ...(ticket.assignedTo ? [ticket.assignedTo] : [])] } });
    await ticket.populate(populated);
    hideOtherAgentProposals(ticket, req);
    hideTeamCoordinationFromClient(ticket, req);
    res.json({ success: true, data: { ticket } });
  } catch (error) { next(error); }
});

ticketRouter.patch('/:id/reopen', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'client') { res.status(403).json({ success: false, message: 'Only clients can reopen their own requests.' }); return; }
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    let ticket = await Ticket.findOne({ _id: req.params.id, clientId: req.user!.id });
    if (!ticket) { res.status(404).json({ success: false, message: 'Ticket not found.' }); return; }
    if (ticket.status !== 'Ready for review' && ticket.status !== 'Resolved' && ticket.status !== 'Closed') { res.status(409).json({ success: false, message: 'Only a request awaiting review or already complete can be reopened.' }); return; }
    const previousStatus = ticket.status;
    const wasReadyForReview = previousStatus === 'Ready for review';
    const assignedAgent = ticket.assignedTo ? await User.findOne({ _id: ticket.assignedTo, role: 'agent', isBanned: { $ne: true }, approvalStatus: 'approved' }).select('_id') : null;
    const returnedToQueue = returnReopenedWorkToQueue(Boolean(assignedAgent));
    const reopened = await Ticket.findOneAndUpdate(
      { _id: ticket._id, clientId: req.user!.id, status: previousStatus },
      { $set: { status: returnedToQueue ? 'Open' : 'In Progress', ...(returnedToQueue ? { assignedTo: null } : {}), workCompletedBy: null, workCompletedAt: null, creditedAgent: null, resolutionConfirmedBy: null, resolutionConfirmedAt: null }, $unset: { agentRating: 1 }, ...(returnedToQueue ? { $pull: { proposals: { agent: ticket.workCompletedBy } } } : {}) },
      { new: true, runValidators: true },
    );
    if (!reopened) { res.status(409).json({ success: false, message: 'The request changed before it could be reopened. Refresh and try again.' }); return; }
    ticket = reopened;
    const admins = await User.find({ role: 'admin' }).select('_id');
    await trackEvent({ actorId: req.user!.id, participantIds: [ticket.clientId, ...(ticket.assignedTo ? [ticket.assignedTo] : [])], action: 'client_reopened', summary: returnedToQueue ? `${req.user!.name} returned “${ticket.title}” to the agency queue because its agent is unavailable` : wasReadyForReview ? `${req.user!.name} requested changes to “${ticket.title}”` : `${req.user!.name} reopened “${ticket.title}”`, ticketId: ticket._id, details: { from: previousStatus, to: ticket.status, returnedToQueue }, notification: { type: 'status_changed', title: returnedToQueue ? 'Request returned to the agency queue' : wasReadyForReview ? 'Client requested changes' : 'Client reopened a request', message: returnedToQueue ? `“${ticket.title}” is back in the agency queue because its previous agent is unavailable.` : wasReadyForReview ? `${req.user!.name} requested changes to “${ticket.title}”.` : `“${ticket.title}” was reopened by ${req.user!.name}.`, recipientIds: [...admins.map(admin => admin._id), ...(ticket.assignedTo ? [ticket.assignedTo] : [])] } });
    await ticket.populate(populated);
    hideOtherAgentProposals(ticket, req);
    hideTeamCoordinationFromClient(ticket, req);
    res.json({ success: true, data: { ticket } });
  } catch (error) { next(error); }
});
