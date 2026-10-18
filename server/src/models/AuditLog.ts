import { Schema, model, type Document, type Types } from 'mongoose';

export type AuditAction = 'client_registered' | 'agent_registered' | 'agent_approved' | 'agent_rejected' | 'ticket_created' | 'request_edited' | 'status_changed' | 'work_ready_for_review' | 'priority_changed' | 'assignee_changed' | 'agent_proposed' | 'due_date_changed' | 'comment_added' | 'client_resolved' | 'client_reopened' | 'private_message_sent' | 'message_deleted' | 'message_edited' | 'request_deleted' | 'user_banned' | 'user_unbanned' | 'user_deleted' | 'progress_updated' | 'assistance_offered' | 'assistance_offer_decided' | 'team_message_sent';
export interface IAuditLog extends Document {
  actor: Types.ObjectId; participants: Types.ObjectId[]; action: AuditAction; summary: string; ticket?: Types.ObjectId; conversation?: Types.ObjectId; details?: Record<string, unknown>; createdAt: Date;
}
const auditLogSchema = new Schema<IAuditLog>({
  actor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  participants: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
  action: { type: String, enum: ['client_registered', 'agent_registered', 'agent_approved', 'agent_rejected', 'ticket_created', 'request_edited', 'status_changed', 'work_ready_for_review', 'priority_changed', 'assignee_changed', 'agent_proposed', 'due_date_changed', 'comment_added', 'client_resolved', 'client_reopened', 'private_message_sent', 'message_deleted', 'message_edited', 'request_deleted', 'user_banned', 'user_unbanned', 'user_deleted', 'progress_updated', 'assistance_offered', 'assistance_offer_decided', 'team_message_sent'], required: true },
  summary: { type: String, required: true, maxlength: 240 },
  ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', index: true },
  conversation: { type: Schema.Types.ObjectId, ref: 'DirectConversation', index: true },
  details: { type: Schema.Types.Mixed },
}, { timestamps: { createdAt: true, updatedAt: false } });
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, 'details.creditedAgent': 1, createdAt: -1, _id: -1 });
export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);
