import { Schema, model, type Document, type Types } from 'mongoose';

export type NotificationType = 'ticket_created' | 'comment_added' | 'status_changed' | 'assignee_changed' | 'agent_proposal' | 'private_message' | 'agent_approved' | 'agent_pending' | 'assistance_offer' | 'blocker_attention' | 'team_message';
export interface INotification extends Document {
  recipient: Types.ObjectId; actor: Types.ObjectId; ticket?: Types.ObjectId | null; conversation?: Types.ObjectId | null; link?: string; type: NotificationType; title: string; message: string; readAt: Date | null; createdAt: Date;
}
const notificationSchema = new Schema<INotification>({
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
  conversation: { type: Schema.Types.ObjectId, ref: 'DirectConversation', default: null },
  link: { type: String },
  type: { type: String, enum: ['ticket_created', 'comment_added', 'status_changed', 'assignee_changed', 'agent_proposal', 'private_message', 'agent_approved', 'agent_pending', 'assistance_offer', 'blocker_attention', 'team_message'], required: true },
  title: { type: String, required: true, maxlength: 100 },
  message: { type: String, required: true, maxlength: 240 },
  readAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });
notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, ticket: 1, type: 1 }, { unique: true, partialFilterExpression: { type: 'blocker_attention' } });
export const Notification = model<INotification>('Notification', notificationSchema);
