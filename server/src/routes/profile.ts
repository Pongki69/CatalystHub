import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { User } from '../models/User';
import { Ticket } from '../models/Ticket';
import { AuditLog } from '../models/AuditLog';
import { authenticate, type AuthRequest } from '../middleware/auth';

export const profileRouter = Router();
profileRouter.use(authenticate);

async function agentCompletionStats(agentId: string) {
  const filter = { action: 'client_resolved', 'details.creditedAgent': agentId };
  const [rows, ratedEvents] = await Promise.all([AuditLog.aggregate([
    { $match: { action: 'client_resolved', 'details.creditedAgent': agentId } },
    { $group: { _id: null, completedCount: { $sum: 1 }, ratingTotal: { $sum: { $cond: [{ $isNumber: '$details.agentRating' }, '$details.agentRating', 0] } }, ratingCount: { $sum: { $cond: [{ $isNumber: '$details.agentRating' }, 1, 0] } } } },
  ]), AuditLog.find({ ...filter, 'details.agentRating': { $type: 'number' } }).select('ticket')]);
  const ratedTicketIds = ratedEvents.map(event => event.ticket).filter(Boolean);
  const legacyRatings = await Ticket.find({ status: 'Resolved', creditedAgent: agentId, agentRating: { $type: 'number' }, _id: { $nin: ratedTicketIds } }).select('agentRating');
  const stats = rows[0] || { completedCount: 0, ratingTotal: 0, ratingCount: 0 };
  const ratingTotal = legacyRatings.reduce((sum, ticket) => sum + (ticket.agentRating || 0), stats.ratingTotal);
  const ratingCount = stats.ratingCount + legacyRatings.length;
  return { completedCount: stats.completedCount, ratingTotal, ratingCount };
}

profileRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const user = await User.findById(req.user!.id).read('primary').select('name email role company bio jobTitle location website avatarUrl coverUrl createdAt');
    if (!user) { res.status(404).json({ success: false, message: 'Profile not found.' }); return; }
    const stats = user.role === 'agent' ? await agentCompletionStats(user.id) : user.role === 'client' ? { requestCount: await Ticket.countDocuments({ clientId: user._id }) } : {};
    res.json({ success: true, data: { user: { id: user.id, name: user.name, email: user.email, role: user.role, company: user.company || '', bio: user.bio || '', jobTitle: user.jobTitle || '', location: user.location || '', website: user.website || '', avatarUrl: user.avatarUrl || '', coverUrl: user.coverUrl || '', createdAt: user.createdAt, ...stats, averageRating: 'ratingCount' in stats && stats.ratingCount ? Number((stats.ratingTotal / stats.ratingCount).toFixed(1)) : null } } });
  } catch (error) { next(error); }
});

profileRouter.patch('/', async (req: AuthRequest, res, next) => {
  try {
    const schema = z.object({
      name: z.string().trim().min(2).max(80),
      company: z.string().trim().max(120).optional().default(''),
      bio: z.string().trim().max(500).optional().default(''),
      jobTitle: z.string().trim().max(100).optional().default(''),
      location: z.string().trim().max(120).optional().default(''),
      website: z.string().trim().max(200).optional().default('').refine(value => !value || /^https?:\/\//i.test(value), 'Enter a website starting with https:// or http://.'),
      currentPassword: z.string().optional(),
      newPassword: z.string().min(8).max(100).optional().or(z.literal('')),
      confirmPassword: z.string().optional().default(''),
    }).refine(value => !value.newPassword || Boolean(value.currentPassword), { message: 'Enter your current password to set a new password.' })
      .refine(value => !value.newPassword || value.newPassword === value.confirmPassword, { message: 'Passwords do not match.' });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    const user = await User.findById(req.user!.id).select('+passwordHash');
    if (!user) { res.status(404).json({ success: false, message: 'Profile not found.' }); return; }
    const profileUpdate = {
      name: parsed.data.name,
      company: parsed.data.company,
      bio: parsed.data.bio,
      jobTitle: parsed.data.jobTitle,
      location: parsed.data.location,
      website: parsed.data.website,
    };
    if (parsed.data.newPassword) {
      if (!parsed.data.currentPassword || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) { res.status(400).json({ success: false, message: 'Your current password is incorrect.' }); return; }
      Object.assign(profileUpdate, { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12) });
    }
    // Use an explicit MongoDB update and return the persisted document so the
    // success response and the public profile read from the same saved values.
    const savedUser = await User.findByIdAndUpdate(
      user._id,
      { $set: profileUpdate },
      { new: true, runValidators: true },
    );
    if (!savedUser) { res.status(404).json({ success: false, message: 'Profile not found.' }); return; }
    res.json({ success: true, data: { user: { id: savedUser.id, name: savedUser.name, email: savedUser.email, role: savedUser.role, company: savedUser.company || '', bio: savedUser.bio || '', jobTitle: savedUser.jobTitle || '', location: savedUser.location || '', website: savedUser.website || '', avatarUrl: savedUser.avatarUrl || '', coverUrl: savedUser.coverUrl || '', createdAt: savedUser.createdAt } } });
  } catch (error) { next(error); }
});

profileRouter.patch('/email', async (req: AuthRequest, res, next) => {
  try {
    const parsed = z.object({ email: z.string().trim().email(), currentPassword: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    const email = parsed.data.email.toLowerCase();
    if (await User.exists({ email, _id: { $ne: req.user!.id } })) { res.status(409).json({ success: false, message: 'That email is already in use.' }); return; }
    const user = await User.findById(req.user!.id).select('+passwordHash');
    if (!user) { res.status(404).json({ success: false, message: 'Profile not found.' }); return; }
    if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) { res.status(400).json({ success: false, message: 'Your current password is incorrect.' }); return; }
    user.email = email;
    await user.save();
    res.json({ success: true, data: { user: { id: user.id, name: user.name, email: user.email, role: user.role, company: user.company || '', bio: user.bio || '', jobTitle: user.jobTitle || '', location: user.location || '', website: user.website || '', avatarUrl: user.avatarUrl || '', coverUrl: user.coverUrl || '' } } });
  } catch (error) { next(error); }
});

profileRouter.patch('/appearance', async (req: AuthRequest, res, next) => {
  try {
    const image = (maxLength: number) => z.string().max(maxLength).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/, 'Choose a valid cropped image.').nullable();
    const parsed = z.object({ avatarUrl: image(700000).optional(), coverUrl: image(1400000).optional() }).refine(value => value.avatarUrl !== undefined || value.coverUrl !== undefined, 'Choose a profile photo or cover image to save.').safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    for (const [field, value] of Object.entries(parsed.data)) {
      if (typeof value === 'string') {
        const encoded = value.slice(value.indexOf(',') + 1);
        const size = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
        if (size > (field === 'avatarUrl' ? 500 * 1024 : 1024 * 1024)) { res.status(400).json({ success: false, message: field === 'avatarUrl' ? 'Profile photos must be 500 KB or smaller.' : 'Cover images must be 1 MB or smaller.' }); return; }
      }
    }
    const user = await User.findById(req.user!.id);
    if (!user) { res.status(404).json({ success: false, message: 'Profile not found.' }); return; }
    if (parsed.data.avatarUrl !== undefined) user.avatarUrl = parsed.data.avatarUrl || undefined;
    if (parsed.data.coverUrl !== undefined) user.coverUrl = parsed.data.coverUrl || undefined;
    await user.save();
    res.json({ success: true, data: { user: { id: user.id, name: user.name, email: user.email, role: user.role, company: user.company || '', bio: user.bio || '', jobTitle: user.jobTitle || '', location: user.location || '', website: user.website || '', avatarUrl: user.avatarUrl || '', coverUrl: user.coverUrl || '' } } });
  } catch (error) { next(error); }
});

profileRouter.get('/completions', async (req: AuthRequest, res, next) => {
  try {
    if (req.user!.role !== 'agent') { res.status(403).json({ success: false, message: 'Completion history is available to agents only.' }); return; }
    res.set('Cache-Control', 'no-store');
    const filter: Record<string, unknown> = { action: 'client_resolved', 'details.creditedAgent': req.user!.id };
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      const escaped = req.query.search.trim().slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ summary: { $regex: escaped, $options: 'i' } }, { 'details.ticketTitle': { $regex: escaped, $options: 'i' } }, { 'details.ticketCategory': { $regex: escaped, $options: 'i' } }, { 'details.clientName': { $regex: escaped, $options: 'i' } }];
    }
    const dateFilter: Record<string, Date> = {};
    const parseDate = (value: unknown): Date | null => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
    };
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (req.query.from !== undefined && !from) { res.status(400).json({ success: false, message: 'Choose a valid start date.' }); return; }
    if (req.query.to !== undefined && !to) { res.status(400).json({ success: false, message: 'Choose a valid end date.' }); return; }
    if (from && to && from > to) { res.status(400).json({ success: false, message: 'The start date must be on or before the end date.' }); return; }
    if (from) dateFilter.$gte = from;
    if (to) dateFilter.$lte = new Date(`${req.query.to}T23:59:59.999Z`);
    if (Object.keys(dateFilter).length) filter.createdAt = dateFilter;
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 25;
    const requestedSkip = Number(req.query.skip);
    const skip = Number.isFinite(requestedSkip) ? Math.min(Math.max(requestedSkip, 0), 10000) : 0;
    const [events, total] = await Promise.all([
      AuditLog.find(filter).populate({ path: 'ticket', select: 'title category clientId status', populate: { path: 'clientId', select: 'name role' } }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
      AuditLog.countDocuments(filter),
    ]);
    res.json({ success: true, data: { completions: events.map(event => ({ _id: event.id, ticket: event.ticket, ticketTitle: event.details?.ticketTitle, ticketCategory: event.details?.ticketCategory, clientName: event.details?.clientName, confirmedAt: event.createdAt, agentRating: event.details?.agentRating })), total, nextSkip: skip + events.length, hasMore: skip + events.length < total } });
  } catch (error) { next(error); }
});

profileRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) { res.status(404).json({ success: false, message: 'Profile not found.' }); return; }
    res.set('Cache-Control', 'no-store');
    const user = await User.findOne({ _id: req.params.id, isBanned: false, approvalStatus: 'approved' }).read('primary').select('name role company bio jobTitle location website avatarUrl coverUrl createdAt');
    if (!user) { res.status(404).json({ success: false, message: 'Profile not found.' }); return; }
    const stats = user.role === 'agent'
      ? await agentCompletionStats(user.id)
      : user.role === 'client' && (req.user!.role === 'admin' || req.user!.role === 'agent' || req.user!.id === user.id) ? { requestCount: await Ticket.countDocuments({ clientId: user._id, ...(req.user!.role === 'admin' || req.user!.id === user.id ? {} : { $or: [{ assignedTo: req.user!.id }, { assignedTo: null, status: 'Open' }] }) }) } : {};
    res.json({ success: true, data: { user: { id: user.id, name: user.name, role: user.role, company: user.company || '', bio: user.bio || '', jobTitle: user.jobTitle || '', location: user.location || '', website: user.website || '', avatarUrl: user.avatarUrl || '', coverUrl: user.coverUrl || '', createdAt: user.createdAt, ...stats, averageRating: 'ratingCount' in stats && stats.ratingCount ? Number((stats.ratingTotal / stats.ratingCount).toFixed(1)) : null } } });
  } catch (error) { next(error); }
});
