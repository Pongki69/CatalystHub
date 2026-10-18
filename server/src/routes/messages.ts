import { Router } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { DirectConversation } from '../models/DirectConversation';
import { DirectMessage } from '../models/DirectMessage';
import { Notification } from '../models/Notification';
import { Ticket } from '../models/Ticket';
import { User } from '../models/User';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { trackEvent } from '../services/events';
import { validateAttachment } from '../services/attachmentValidation';
import { directMessageInputSchema } from '../services/messageContracts';

export const messageRouter = Router();
messageRouter.use(authenticate);
const reactionEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
const participantsKey = (ids: string[]) => ids.slice().sort().join(':');
const isParticipant = (participants: unknown[], userId: string) => participants.some(value => {
  const id = value && typeof value === 'object' && '_id' in value ? (value as { _id: unknown })._id : value;
  return String(id) === userId;
});

messageRouter.get('/contacts', async (req: AuthRequest, res, next) => {
  try {
    let filter: Record<string, unknown>;
    if (req.user!.role === 'client') filter = { role: { $in: ['agent', 'admin'] }, approvalStatus: 'approved' };
    else if (req.user!.role === 'admin') filter = { _id: { $ne: req.user!.id }, approvalStatus: 'approved' };
    else {
      const assigned = await Ticket.find({ assignedTo: req.user!.id }).distinct('clientId');
      filter = { _id: { $in: assigned }, role: 'client' };
    }
    const contacts = await User.find(filter).select('name email role avatarUrl company').sort({ name: 1 });
    res.json({ success: true, data: { contacts: contacts.map(contact => ({ id: contact.id, name: contact.name, email: contact.email, role: contact.role, avatarUrl: contact.avatarUrl || '', company: contact.company || '' })) } });
  } catch (error) { next(error); }
});

messageRouter.get('/conversations', async (req: AuthRequest, res, next) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const cursorDate = typeof req.query.beforeDate === 'string' ? new Date(req.query.beforeDate) : null;
    const cursorId = typeof req.query.beforeId === 'string' ? req.query.beforeId : '';
    if ((cursorDate && Number.isNaN(cursorDate.getTime())) || (cursorId && !isValidObjectId(cursorId)) || Boolean(cursorDate) !== Boolean(cursorId)) { res.status(400).json({ success: false, message: 'Choose a valid conversation page cursor.' }); return; }
    const match: Record<string, unknown> = { participants: new Types.ObjectId(req.user!.id) };
    if (cursorDate && cursorId) match.$or = [{ lastMessageAt: { $lt: cursorDate } }, { lastMessageAt: cursorDate, _id: { $lt: new Types.ObjectId(cursorId) } }];
    const rows = await DirectConversation.aggregate([
      { $match: match },
      { $sort: { lastMessageAt: -1, _id: -1 } },
      { $limit: limit + 1 },
      { $lookup: { from: DirectMessage.collection.name, let: { conversationId: '$_id' }, pipeline: [
        { $match: { $expr: { $eq: ['$conversation', '$$conversationId'] } } },
        { $sort: { createdAt: -1, _id: -1 } }, { $limit: 1 },
        { $project: { sender: 1, message: 1, createdAt: 1, editedAt: 1, deletedAt: 1, deletedBy: 1, 'attachment.kind': 1, 'attachment.name': 1, 'attachment.mimeType': 1, 'attachment.size': 1, 'attachments.kind': 1, 'attachments.name': 1, 'attachments.mimeType': 1, 'attachments.size': 1 } },
        { $lookup: { from: User.collection.name, let: { senderId: '$sender' }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$senderId'] } } }, { $project: { name: 1, role: 1, avatarUrl: 1 } }], as: 'sender' } },
        { $unwind: { path: '$sender', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: User.collection.name, let: { deletedById: '$deletedBy' }, pipeline: [{ $match: { $expr: { $eq: ['$_id', '$$deletedById'] } } }, { $project: { name: 1, role: 1 } }], as: 'deletedBy' } },
        { $unwind: { path: '$deletedBy', preserveNullAndEmptyArrays: true } },
      ], as: 'latestMessage' } },
      { $unwind: { path: '$latestMessage', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: User.collection.name, let: { participantIds: '$participants' }, pipeline: [{ $match: { $expr: { $in: ['$_id', '$$participantIds'] } } }, { $project: { name: 1, email: 1, role: 1, avatarUrl: 1, coverUrl: 1, company: 1 } }], as: 'participants' } },
    ]);
    const hasMore = rows.length > limit;
    const conversations = rows.slice(0, limit).map(conversation => ({ ...conversation, otherParticipant: conversation.participants.find((participant: { _id: unknown }) => String(participant._id) !== req.user!.id), latestMessage: conversation.latestMessage || null }));
    const last = conversations.at(-1);
    res.json({ success: true, data: { conversations, hasMore, nextCursor: hasMore && last ? { beforeDate: last.lastMessageAt, beforeId: last._id } : null } });
  } catch (error) { next(error); }
});

messageRouter.post('/conversations', async (req: AuthRequest, res, next) => {
  try {
    const parsed = z.object({ recipientId: z.string().refine(isValidObjectId).optional(), recipientIds: z.array(z.string().refine(isValidObjectId)).min(1).max(9).optional(), groupName: z.string().trim().max(80).optional() }).refine(value => Boolean(value.recipientId || value.recipientIds?.length), 'Choose at least one contact.').safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    const recipientIds = [...new Set([...(parsed.data.recipientIds || []), ...(parsed.data.recipientId ? [parsed.data.recipientId] : [])])];
    if (recipientIds.includes(req.user!.id)) { res.status(400).json({ success: false, message: 'You cannot add yourself to a conversation.' }); return; }
    const recipients = await User.find({ _id: { $in: recipientIds }, approvalStatus: 'approved' }).select('name email role avatarUrl company');
    if (recipients.length !== recipientIds.length) { res.status(404).json({ success: false, message: 'One or more selected contacts are not available.' }); return; }
    for (const recipient of recipients) {
      if (req.user!.role === 'client' && recipient.role === 'client') { res.status(403).json({ success: false, message: 'Clients can start private conversations with agency staff.' }); return; }
      if (req.user!.role === 'agent' && recipient.role === 'client' && !await Ticket.exists({ assignedTo: req.user!.id, clientId: recipient.id })) { res.status(403).json({ success: false, message: 'Agents can message only clients assigned to them.' }); return; }
    }
    const participantIds = [req.user!.id, ...recipients.map(recipient => recipient.id)];
    const key = participantsKey(participantIds);
    let conversation = await DirectConversation.findOne({ participantKey: key }).populate('participants', 'name email role avatarUrl coverUrl company');
    if (!conversation) {
      conversation = await DirectConversation.create({ participants: participantIds, participantKey: key, ...(recipients.length > 1 && parsed.data.groupName ? { groupName: parsed.data.groupName } : {}), lastMessageAt: new Date() });
      await conversation.populate('participants', 'name email role avatarUrl coverUrl company');
    }
    res.status(201).json({ success: true, data: { conversation } });
  } catch (error) { next(error); }
});

messageRouter.get('/conversations/:id/messages', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Conversation not found.' }); return; }
    const conversation = await DirectConversation.findById(req.params.id);
    if (!conversation || !isParticipant(conversation.participants, req.user!.id)) { res.status(404).json({ success: false, message: 'Conversation not found.' }); return; }
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 50);
    const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
    const around = typeof req.query.around === 'string' && isValidObjectId(req.query.around) ? req.query.around : null;
    if (around) {
      const target = await DirectMessage.findOne({ _id: around, conversation: conversation._id }).populate('sender', 'name role avatarUrl').populate('deletedBy', 'name role');
      if (!target) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
      const [older, newer, olderCount] = await Promise.all([
        DirectMessage.find({ conversation: conversation._id, $or: [{ createdAt: { $lt: target.createdAt } }, { createdAt: target.createdAt, _id: { $lt: target._id } }] }).populate('sender', 'name role avatarUrl').populate('deletedBy', 'name role').sort({ createdAt: -1, _id: -1 }).limit(15),
        DirectMessage.find({ conversation: conversation._id, $or: [{ createdAt: { $gt: target.createdAt } }, { createdAt: target.createdAt, _id: { $gt: target._id } }] }).populate('sender', 'name role avatarUrl').populate('deletedBy', 'name role').sort({ createdAt: 1, _id: 1 }).limit(14),
        DirectMessage.countDocuments({ conversation: conversation._id, $or: [{ createdAt: { $lt: target.createdAt } }, { createdAt: target.createdAt, _id: { $lt: target._id } }] }),
      ]);
      res.json({ success: true, data: { conversation, messages: [...older.reverse(), target, ...newer], hasMore: olderCount > older.length } }); return;
    }
    const filter = { conversation: conversation._id, ...(before ? { createdAt: { $lt: before } } : {}) };
    const [messages, olderCount] = await Promise.all([
      DirectMessage.find(filter).populate('sender', 'name role avatarUrl').populate('deletedBy', 'name role').sort({ createdAt: -1 }).limit(limit).then(items => items.reverse()),
      DirectMessage.countDocuments(filter),
      Notification.updateMany({ conversation: conversation._id, recipient: req.user!.id, readAt: null }, { $set: { readAt: new Date() } }),
    ]);
    res.json({ success: true, data: { conversation, messages, hasMore: olderCount > messages.length } });
  } catch (error) { next(error); }
});

// Search the full accessible conversation history rather than only the messages
// currently loaded in the browser. Results intentionally omit attachment data
// URLs; the authorized media endpoint can load those when a user opens an item.
messageRouter.get('/conversations/:id/search', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Conversation not found.' }); return; }
    const conversation = await DirectConversation.findById(req.params.id).select('participants');
    if (!conversation || !isParticipant(conversation.participants, req.user!.id)) { res.status(404).json({ success: false, message: 'Conversation not found.' }); return; }
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
    if (!query) { res.json({ success: true, data: { results: [], hasMore: false } }); return; }
    const kind = typeof req.query.kind === 'string' ? req.query.kind : 'all';
    if (!['all', 'image', 'audio', 'file', 'link'].includes(kind)) { res.status(400).json({ success: false, message: 'Choose a supported search filter.' }); return; }
    const rawLimit = Number(req.query.limit); const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 25;
    const rawOffset = Number(req.query.offset); const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(rawOffset, 0), 10000) : 0;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter: Record<string, unknown> = { conversation: conversation._id, deletedAt: { $exists: false } };
    if (kind === 'link') filter.message = { $regex: escaped, $options: 'i' };
    else {
      const matchingSenders = await User.find({ _id: { $in: conversation.participants }, name: { $regex: escaped, $options: 'i' } }).distinct('_id');
      filter.$or = [{ message: { $regex: escaped, $options: 'i' } }, ...(matchingSenders.length ? [{ sender: { $in: matchingSenders } }] : [])];
      if (kind !== 'all') filter.$and = [{ $or: filter.$or as unknown[] }, { $or: [{ 'attachment.kind': kind }, { 'attachments.kind': kind }] }], delete filter.$or;
    }
    if (typeof req.query.sender === 'string' && isValidObjectId(req.query.sender)) filter.sender = req.query.sender;
    if (typeof req.query.from === 'string' || typeof req.query.to === 'string') {
      const createdAt: Record<string, Date> = {};
      if (typeof req.query.from === 'string' && !Number.isNaN(Date.parse(req.query.from))) createdAt.$gte = new Date(req.query.from);
      if (typeof req.query.to === 'string' && !Number.isNaN(Date.parse(req.query.to))) createdAt.$lte = new Date(req.query.to);
      if (Object.keys(createdAt).length) filter.createdAt = createdAt;
    }
    const [rows, total] = await Promise.all([
      DirectMessage.find(filter).select('conversation sender message createdAt editedAt attachment.kind attachment.name attachment.mimeType attachment.size attachments.kind attachments.name attachments.mimeType attachments.size')
        .populate('sender', 'name role avatarUrl').sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit + 1),
      DirectMessage.countDocuments(filter),
    ]);
    const results = rows.slice(0, limit);
    res.json({ success: true, data: { results, total, hasMore: offset + results.length < total, nextOffset: offset + results.length } });
  } catch (error) { next(error); }
});

messageRouter.get('/conversations/:id/media', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Conversation not found.' }); return; }
    const conversation = await DirectConversation.findById(req.params.id).select('participants');
    if (!conversation || !isParticipant(conversation.participants, req.user!.id)) { res.status(404).json({ success: false, message: 'Conversation not found.' }); return; }
    const requested = typeof req.query.kind === 'string' ? req.query.kind : 'all';
    if (!['all', 'image', 'audio', 'file'].includes(requested)) { res.status(400).json({ success: false, message: 'Choose a supported media category.' }); return; }
    const rawLimit = Number(req.query.limit); const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 30;
    const rawOffset = Number(req.query.offset); const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(rawOffset, 0), 10000) : 0;
    const filter: Record<string, unknown> = { conversation: conversation._id, deletedAt: { $exists: false }, $or: [{ 'attachment.kind': { $exists: true } }, { 'attachments.0': { $exists: true } }] };
    if (requested !== 'all') filter.$and = [{ $or: [{ 'attachment.kind': requested }, { 'attachments.kind': requested }] }];
    const [items, total] = await Promise.all([
      DirectMessage.find(filter).select('sender message createdAt attachment attachments').populate('sender', 'name role avatarUrl').sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit + 1),
      DirectMessage.countDocuments(filter),
    ]);
    const messages = items.slice(0, limit);
    res.json({ success: true, data: { messages, total, hasMore: offset + messages.length < total, nextOffset: offset + messages.length } });
  } catch (error) { next(error); }
});

messageRouter.post('/conversations/:id/messages', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Conversation not found.' }); return; }
    const parsed = directMessageInputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    for (const attachment of [parsed.data.attachment, ...(parsed.data.attachments || [])].filter(Boolean)) { const attachmentError = validateAttachment(attachment!); if (attachmentError) { res.status(400).json({ success: false, message: attachmentError }); return; } }
    const conversation = await DirectConversation.findById(req.params.id).populate('participants', 'name email role avatarUrl coverUrl company');
    if (!conversation || !isParticipant(conversation.participants, req.user!.id)) { res.status(404).json({ success: false, message: 'Conversation not found.' }); return; }
    const recipients = (conversation.participants as unknown as Array<{ _id: unknown; name: string }>).filter(participant => String(participant._id) !== req.user!.id);
    if (!recipients.length) { res.status(404).json({ success: false, message: 'Conversation recipient not found.' }); return; }
    if (parsed.data.submissionId) {
      const existing = await DirectMessage.findOne({ submissionId: parsed.data.submissionId, conversation: conversation._id, sender: req.user!.id }).select('+submissionId').populate('sender', 'name role avatarUrl');
      if (existing) { res.status(200).json({ success: true, data: { message: existing, duplicate: true } }); return; }
    }
    const message = await DirectMessage.create({ conversation: conversation._id, sender: req.user!.id, message: parsed.data.message, attachment: parsed.data.attachment, attachments: parsed.data.attachments, ...(parsed.data.submissionId ? { submissionId: parsed.data.submissionId } : {}) });
    conversation.lastMessageAt = new Date();
    await conversation.save();
    await trackEvent({ actorId: req.user!.id, participantIds: recipients.map(recipient => String(recipient._id)), conversationId: conversation._id, action: 'private_message_sent', summary: `${req.user!.name} sent a message in ${conversation.groupName || recipients.map(recipient => recipient.name).join(', ')}`, notification: { type: 'private_message', title: 'New private message', message: `${req.user!.name} sent you a private message.`, recipientIds: recipients.map(recipient => String(recipient._id)), link: `/messages/${conversation.id}` } });
    await message.populate('sender', 'name role avatarUrl');
    res.status(201).json({ success: true, data: { message } });
  } catch (error) { next(error); }
});

messageRouter.delete('/conversations/:id/messages/:messageId', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.messageId)) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const conversation = await DirectConversation.findById(req.params.id);
    if (!conversation || !isParticipant(conversation.participants, req.user!.id)) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const message = await DirectMessage.findOne({ _id: req.params.messageId, conversation: conversation._id });
    if (!message) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    if (message.sender.toString() !== req.user!.id && req.user!.role !== 'admin') { res.status(403).json({ success: false, message: 'You can delete only your own messages.' }); return; }
    if (!message.deletedAt) { message.deletedAt = new Date(); message.deletedBy = new Types.ObjectId(req.user!.id); message.message = ''; message.attachment = undefined; message.attachments = []; await message.save(); }
    const latest = await DirectMessage.findOne({ conversation: conversation._id, deletedAt: { $exists: false } }).sort({ createdAt: -1 }).select('createdAt');
    conversation.lastMessageAt = latest?.createdAt || conversation.createdAt;
    await conversation.save();
    const otherParticipants = conversation.participants.filter(participant => String(participant) !== req.user!.id);
    await trackEvent({ actorId: req.user!.id, participantIds: otherParticipants, conversationId: conversation._id, action: 'message_deleted', summary: `${req.user!.name} deleted a private message` });
    res.json({ success: true, data: { deleted: true } });
  } catch (error) { next(error); }
});

messageRouter.post('/conversations/:id/messages/:messageId/reactions', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.messageId)) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const parsed = z.object({ emoji: z.enum(reactionEmojis) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Choose a supported reaction.' }); return; }
    const conversation = await DirectConversation.findById(req.params.id);
    if (!conversation || !isParticipant(conversation.participants, req.user!.id)) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const message = await DirectMessage.findOne({ _id: req.params.messageId, conversation: conversation._id, deletedAt: { $exists: false } });
    if (!message) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const reactions = message.reactions as Array<{ user: Types.ObjectId; emoji: string }>;
    const index = reactions.findIndex(reaction => String(reaction.user) === req.user!.id);
    if (index >= 0 && reactions[index].emoji === parsed.data.emoji) reactions.splice(index, 1);
    else if (index >= 0) reactions[index].emoji = parsed.data.emoji;
    else reactions.push({ user: new Types.ObjectId(req.user!.id), emoji: parsed.data.emoji as typeof reactionEmojis[number] });
    await message.save();
    res.json({ success: true, data: { reactions: reactions.map(reaction => ({ user: String(reaction.user), emoji: reaction.emoji })) } });
  } catch (error) { next(error); }
});

messageRouter.patch('/conversations/:id/messages/:messageId', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id) || !isValidObjectId(req.params.messageId)) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const parsed = z.object({ message: z.string().trim().min(1).max(20000).refine(value => value.split(/\s+/).filter(Boolean).length <= 2000, 'Messages can contain at most 2,000 words.') }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Message text must be between 1 and 2000 characters.' }); return; }
    const conversation = await DirectConversation.findById(req.params.id);
    if (!conversation || !isParticipant(conversation.participants, req.user!.id)) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    const message = await DirectMessage.findOne({ _id: req.params.messageId, conversation: conversation._id, deletedAt: { $exists: false } });
    if (!message) { res.status(404).json({ success: false, message: 'Message not found.' }); return; }
    if (message.sender.toString() !== req.user!.id) { res.status(403).json({ success: false, message: 'You can edit only your own messages.' }); return; }
    message.message = parsed.data.message;
    message.editedAt = new Date();
    await message.save();
    const otherParticipants = conversation.participants.filter(participant => String(participant) !== req.user!.id);
    await trackEvent({ actorId: req.user!.id, participantIds: otherParticipants, conversationId: conversation._id, action: 'message_edited', summary: `${req.user!.name} edited a private message` });
    res.json({ success: true, data: { edited: true } });
  } catch (error) { next(error); }
});
