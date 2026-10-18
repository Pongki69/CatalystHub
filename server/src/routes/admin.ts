import { Router } from 'express';
import { AuditLog } from '../models/AuditLog';
import { isValidObjectId } from 'mongoose';
import { User } from '../models/User';
import { Ticket } from '../models/Ticket';
import { ThreadMessage } from '../models/ThreadMessage';
import { DirectConversation } from '../models/DirectConversation';
import { DirectMessage } from '../models/DirectMessage';
import { Notification } from '../models/Notification';
import { authenticate, requireAdmin, type AuthRequest } from '../middleware/auth';
import { trackEvent } from '../services/events';
import { releaseActiveWorkForUser } from '../services/workAssignment';
import { activityActorProjection } from '../services/activityPrivacy';
import { hasAgentHistory } from '../services/ticketPolicy';

export const adminRouter = Router();

adminRouter.get('/activity', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 12;
    const requestedSkip = Number(req.query.skip);
    const skip = Number.isFinite(requestedSkip) ? Math.min(Math.max(requestedSkip, 0), 10000) : 0;
    const filter: Record<string, unknown> = req.user!.role === 'admin' ? {} : { participants: req.user!.id };
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const actorIds = await User.find({ name: { $regex: escaped, $options: 'i' } }).distinct('_id');
      filter.$or = [{ summary: { $regex: escaped, $options: 'i' } }, { action: { $regex: escaped, $options: 'i' } }, ...(actorIds.length ? [{ actor: { $in: actorIds } }] : [])];
    }
    if (typeof req.query.actorRole === 'string' && ['client', 'agent', 'admin'].includes(req.query.actorRole)) {
      const actorIds = await User.find({ role: req.query.actorRole }).distinct('_id');
      filter.actor = { $in: actorIds };
    }
    const allowedActions = ['client_registered','agent_registered','agent_approved','agent_rejected','ticket_created','request_edited','status_changed','work_ready_for_review','priority_changed','assignee_changed','agent_proposed','due_date_changed','comment_added','client_resolved','client_reopened','private_message_sent','message_deleted','message_edited','request_deleted','user_banned','user_unbanned','user_deleted','progress_updated','assistance_offered','assistance_offer_decided'];
    if (typeof req.query.action === 'string' && allowedActions.includes(req.query.action)) filter.action = req.query.action;
    const from = typeof req.query.from === 'string' && !Number.isNaN(Date.parse(req.query.from)) ? new Date(req.query.from) : null;
    const to = typeof req.query.to === 'string' && !Number.isNaN(Date.parse(req.query.to)) ? new Date(`${req.query.to}T23:59:59.999Z`) : null;
    if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const direction = req.query.sort === 'oldest' ? 1 : -1;
    const [activity, total] = await Promise.all([AuditLog.find(filter).populate('actor', activityActorProjection(req.user!.role)).populate('ticket', 'title').populate('conversation', '_id').sort({ createdAt: direction, _id: direction }).skip(skip).limit(limit), AuditLog.countDocuments(filter)]);
    res.json({ success: true, data: { activity, total, nextSkip: skip + activity.length } });
  } catch (error) { next(error); }
});

adminRouter.use(authenticate, requireAdmin);

adminRouter.get('/users', async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const role = typeof req.query.role === 'string' && ['client','agent','admin'].includes(req.query.role) ? req.query.role : '';
    const approval = typeof req.query.approval === 'string' && ['pending','approved','rejected'].includes(req.query.approval) ? req.query.approval : '';
    const state = typeof req.query.state === 'string' && ['banned','active'].includes(req.query.state) ? req.query.state : '';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const requestedSkip = Number(req.query.skip);
    const skip = Number.isFinite(requestedSkip) ? Math.min(Math.max(requestedSkip, 0), 10000) : 0;
    const filter: Record<string, unknown> = {};
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ name: { $regex: escaped, $options: 'i' } }, { email: { $regex: escaped, $options: 'i' } }, { company: { $regex: escaped, $options: 'i' } }];
    }
    if (role) filter.role = role;
    if (approval) filter.approvalStatus = approval;
    if (state) filter.isBanned = state === 'banned';
    const sortOrder: 1 | -1 = sort === 'oldest' || sort === 'name-asc' ? 1 : -1;
    const sortFields: Record<string, 1 | -1> = sort.startsWith('name-') ? { name: sortOrder, _id: 1 } : { createdAt: sortOrder, _id: sortOrder };
    const [users, total] = await Promise.all([
      User.find(filter).select('name email role approvalStatus company isBanned bannedAt banReason createdAt').sort(sortFields).skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);
    res.json({ success: true, data: { users: users.map(user => ({ ...user.toObject(), id: user.id })), total, nextSkip: skip + users.length } });
  } catch (error) { next(error); }
});

adminRouter.patch('/users/:id/ban', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'User not found.' }); return; }
    const parsed = req.body?.isBanned;
    if (typeof parsed !== 'boolean') { res.status(400).json({ success: false, message: 'Choose whether this account should be banned.' }); return; }
    if (req.params.id === req.user!.id && parsed) { res.status(400).json({ success: false, message: 'You cannot ban your own admin account.' }); return; }
    const user = await User.findById(req.params.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found.' }); return; }
    user.isBanned = parsed;
    user.bannedAt = parsed ? new Date() : undefined;
    user.banReason = parsed && typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 240) : undefined;
    await user.save();
    if (parsed && user.role === 'agent') await releaseActiveWorkForUser(user.id, { id: req.user!.id, name: req.user!.name }, user.name);
    await trackEvent({ actorId: req.user!.id, participantIds: [user.id], action: parsed ? 'user_banned' : 'user_unbanned', summary: `${req.user!.name} ${parsed ? 'banned' : 'unbanned'} ${user.name}`, details: { userId: user.id, role: user.role, reason: user.banReason } });
    res.json({ success: true, data: { user: { id: user.id, name: user.name, email: user.email, role: user.role, isBanned: user.isBanned, bannedAt: user.bannedAt, banReason: user.banReason } } });
  } catch (error) { next(error); }
});

adminRouter.delete('/users/:id', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'User not found.' }); return; }
    if (req.params.id === req.user!.id) { res.status(400).json({ success: false, message: 'You cannot delete your own admin account.' }); return; }
    const user = await User.findById(req.params.id);
    if (!user) { res.status(404).json({ success: false, message: 'User not found.' }); return; }
    if (user.role === 'admin') { res.status(400).json({ success: false, message: 'Admin accounts cannot be deleted here.' }); return; }

    if (user.role === 'agent') {
      const [authoredMessages, privateMessages, legacyComments, assignedWork, completionCredit] = await Promise.all([
        ThreadMessage.exists({ sender: user._id }),
        DirectMessage.exists({ sender: user._id }),
        Ticket.exists({ 'comments.sender': user._id }),
        Ticket.exists({ $or: [{ assignedTo: user._id }, { 'proposals.agent': user._id }] }),
        Ticket.exists({ $or: [{ workCompletedBy: user._id }, { creditedAgent: user._id }] }),
      ]);
      if (hasAgentHistory({ requestMessages: Boolean(authoredMessages), privateMessages: Boolean(privateMessages), legacyComments: Boolean(legacyComments), assignmentsOrProposals: Boolean(assignedWork), completionCredit: Boolean(completionCredit) })) {
        res.status(409).json({ success: false, message: 'This agent has request history. Ban the account to prevent sign-in while preserving delivery notes and work records.' });
        return;
      }
    }

    if (user.role === 'agent') await releaseActiveWorkForUser(user.id, { id: req.user!.id, name: req.user!.name }, user.name);

    const ticketIds = await Ticket.find({ clientId: user._id }).distinct('_id');
    const conversations = await DirectConversation.find({ participants: user._id }).distinct('_id');

    // Remove the account's owned work and its discussion data, plus authored messages elsewhere.
    await Promise.all([
      ThreadMessage.deleteMany({ $or: [{ sender: user._id }, { ticket: { $in: ticketIds } }] }),
      Ticket.deleteMany({ clientId: user._id }),
      Ticket.updateMany({ assignedTo: user._id }, { $set: { assignedTo: null } }),
      Ticket.updateMany({ 'comments.sender': user._id }, { $pull: { comments: { sender: user._id } } }),
      DirectMessage.deleteMany({ $or: [{ sender: user._id }, { conversation: { $in: conversations } }] }),
      DirectConversation.deleteMany({ _id: { $in: conversations } }),
      Notification.deleteMany({ $or: [{ recipient: user._id }, { actor: user._id }, { ticket: { $in: ticketIds } }, { conversation: { $in: conversations } }] }),
      AuditLog.deleteMany({ actor: user._id }),
      AuditLog.updateMany({ participants: user._id }, { $pull: { participants: user._id } }),
    ]);
    const deletedUser = { id: user.id, name: user.name, role: user.role };
    await user.deleteOne();
    await trackEvent({ actorId: req.user!.id, action: 'user_deleted', summary: `${req.user!.name} permanently deleted ${deletedUser.name}'s ${deletedUser.role} account and associated records`, details: { userId: deletedUser.id, role: deletedUser.role } });
    res.json({ success: true, data: { deleted: deletedUser } });
  } catch (error) { next(error); }
});

adminRouter.get('/agent-requests', async (_req, res, next) => {
  try {
    const agents = await User.find({ role: 'agent', approvalStatus: 'pending' }).select('name email role createdAt').sort({ createdAt: 1 });
    res.json({ success: true, data: { agents: agents.map(agent => ({ id: agent.id, name: agent.name, email: agent.email, createdAt: agent.createdAt })) } });
  } catch (error) { next(error); }
});

adminRouter.patch('/agents/:id/approval', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Agent account not found.' }); return; }
    const status = req.body?.status;
    if (status !== 'approved' && status !== 'rejected') { res.status(400).json({ success: false, message: 'Choose approved or rejected.' }); return; }
    const agent = await User.findOne({ _id: req.params.id, role: 'agent' });
    if (!agent) { res.status(404).json({ success: false, message: 'Pending agent account not found.' }); return; }
    const approved = status === 'approved';
    const changed = agent.approvalStatus !== status;
    if (changed) {
      agent.approvalStatus = status;
      await agent.save();
      await trackEvent({ actorId: req.user!.id, participantIds: [agent.id], action: approved ? 'agent_approved' : 'agent_rejected', summary: `${req.user!.name} ${approved ? 'approved' : 'rejected'} agent access for ${agent.name}`, details: { agentId: agent.id, status }, ...(approved ? { notification: { type: 'agent_approved' as const, title: 'Agency access approved', message: 'Your agent account is approved. You can now sign in.', recipientIds: [agent.id], link: '/login' } } : {}) });
    }
    res.json({ success: true, data: { agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role, approvalStatus: agent.approvalStatus } } });
  } catch (error) { next(error); }
});

adminRouter.get('/assignees', async (_req, res, next) => {
  try {
    const assignees = await User.find({ role: 'agent', approvalStatus: 'approved', isBanned: { $ne: true } }).select('name email role').sort({ name: 1 });
    res.json({ success: true, data: { assignees: assignees.map(user => ({ id: user.id, name: user.name, email: user.email, role: user.role })) } });
  } catch (error) { next(error); }
});
