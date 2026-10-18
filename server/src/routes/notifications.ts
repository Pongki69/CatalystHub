import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { Notification } from '../models/Notification';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { notificationRecipientFilter } from '../services/notificationScope';

export const notificationRouter = Router();
notificationRouter.use(authenticate);

notificationRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const recipient = req.user!.id;
    // Admins receive targeted workspace alerts, but notifications remain private to
    // the account that received them. Older admin comment alerts are discarded.
    if (req.user!.role === 'admin') await Notification.deleteMany({ ...notificationRecipientFilter(recipient), type: 'comment_added' });
    const filter = {
      ...notificationRecipientFilter(recipient),
      ...(req.user!.role === 'admin' ? { type: { $ne: 'comment_added' } } : {}),
    };
    const [notifications, unreadCount] = await Promise.all([
      Notification.find(filter).populate('actor', 'name role').populate('ticket', 'title').populate('conversation', '_id').sort({ createdAt: -1 }).limit(30),
      Notification.countDocuments({ ...filter, readAt: null }),
    ]);
    res.json({ success: true, data: { notifications, unreadCount } });
  } catch (error) { next(error); }
});

notificationRouter.patch('/read-all', async (req: AuthRequest, res, next) => {
  try {
    await Notification.updateMany({ ...notificationRecipientFilter(req.user!.id), readAt: null }, { $set: { readAt: new Date() } });
    res.json({ success: true, data: { updated: true } });
  } catch (error) { next(error); }
});

notificationRouter.patch('/:id/read', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Notification not found.' }); return; }
    const read = typeof req.body?.read === 'boolean' ? req.body.read : true;
    const notification = await Notification.findOneAndUpdate({ _id: req.params.id, ...notificationRecipientFilter(req.user!.id) }, { $set: { readAt: read ? new Date() : null } }, { new: true });
    if (!notification) { res.status(404).json({ success: false, message: 'Notification not found.' }); return; }
    res.json({ success: true, data: { notification } });
  } catch (error) { next(error); }
});

notificationRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    if (!isValidObjectId(req.params.id)) { res.status(404).json({ success: false, message: 'Notification not found.' }); return; }
    const notification = await Notification.findOneAndDelete({ _id: req.params.id, ...notificationRecipientFilter(req.user!.id) });
    if (!notification) { res.status(404).json({ success: false, message: 'Notification not found.' }); return; }
    res.json({ success: true, data: { id: notification.id, readAt: notification.readAt } });
  } catch (error) { next(error); }
});
