import { AuditLog, type AuditAction } from '../models/AuditLog';
import { Notification, type NotificationType } from '../models/Notification';
import type { Types } from 'mongoose';

interface EventInput {
  actorId: string; action: AuditAction; summary: string; ticketId?: Types.ObjectId | string;
  conversationId?: Types.ObjectId | string; participantIds?: Array<string | Types.ObjectId>; details?: Record<string, unknown>;
  notification?: { type: NotificationType; title: string; message: string; recipientIds: Array<string | Types.ObjectId>; link?: string };
}

export async function trackEvent(event: EventInput): Promise<void> {
  try {
    const participants = [...new Set([event.actorId, ...(event.participantIds || []).map(String)])];
    const writes: Array<Promise<unknown>> = [AuditLog.create({ actor: event.actorId, participants, action: event.action, summary: event.summary, ...(event.ticketId ? { ticket: event.ticketId } : {}), ...(event.conversationId ? { conversation: event.conversationId } : {}), details: event.details })];
    if (event.notification) {
      const uniqueRecipients = [...new Set(event.notification.recipientIds.map(String))].filter(id => id !== event.actorId);
      if (uniqueRecipients.length) writes.push(Notification.insertMany(uniqueRecipients.map(recipient => ({ recipient, actor: event.actorId, ...(event.ticketId ? { ticket: event.ticketId } : {}), ...(event.conversationId ? { conversation: event.conversationId } : {}), ...(event.notification!.link ? { link: event.notification!.link } : {}), type: event.notification!.type, title: event.notification!.title, message: event.notification!.message }))));
    }
    const results = await Promise.allSettled(writes);
    for (const result of results) if (result.status === 'rejected') console.error('Failed to persist CatalystHub activity event:', result.reason);
  } catch (error) { console.error('Failed to persist CatalystHub activity event:', error); }
}
