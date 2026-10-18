import { Schema, model, type Document, type Types } from 'mongoose';

export type TicketPriority = 'Low' | 'Medium' | 'High';
export type TicketStatus = 'Open' | 'In Progress' | 'Ready for review' | 'Resolved' | 'Closed';
export interface ITicketAgentProposal { agent: Types.ObjectId; message: string; createdAt: Date; updateCount: number; }
export interface ITicketProgressUpdate {
  author: Types.ObjectId; summary: string; completed: string; nextAction: string; blockers: string; assistanceNeeded: boolean; createdAt: Date;
}
export interface ITicketAssistanceOffer {
  _id?: Types.ObjectId; agent: Types.ObjectId; message: string; status: 'pending' | 'accepted' | 'declined'; createdAt: Date; respondedAt?: Date; respondedBy?: Types.ObjectId; acceptedFor?: Types.ObjectId;
}
export interface ITicketComment { sender: Types.ObjectId; message: string; timestamp: Date; reactions?: Array<{ user: Types.ObjectId; emoji: '👍' | '❤️' | '😂' | '😮' | '😢' | '🙏' }>; editedAt?: Date; deletedAt?: Date; deletedBy?: Types.ObjectId; }
export interface ITicket extends Document {
  title: string; description: string; category: string; priority: TicketPriority; status: TicketStatus;
  clientId: Types.ObjectId; assignedTo?: Types.ObjectId | null; workCompletedBy?: Types.ObjectId | null; workCompletedAt?: Date | null; creditedAgent?: Types.ObjectId | null; resolutionConfirmedBy?: Types.ObjectId | null; resolutionConfirmedAt?: Date | null; dueDate?: Date | null; comments: ITicketComment[]; submissionId?: string;
  proposals: ITicketAgentProposal[]; agentRating?: number;
  progressUpdates: ITicketProgressUpdate[]; assistanceOffers: ITicketAssistanceOffer[];
  teamCollaborators?: Array<{ id: string; name: string; avatarUrl?: string }>;
  createdAt: Date; updatedAt: Date;
}
const commentSchema = new Schema<ITicketComment>({
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, trim: true, maxlength: 2000 },
  timestamp: { type: Date, default: Date.now },
  reactions: [{ _id: false, user: { type: Schema.Types.ObjectId, ref: 'User', required: true }, emoji: { type: String, enum: ['👍', '❤️', '😂', '😮', '😢', '🙏'], required: true } }],
  editedAt: { type: Date },
  deletedAt: { type: Date },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { _id: true });
const proposalSchema = new Schema<ITicketAgentProposal>({
  agent: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, trim: true, required: true, maxlength: 1000 },
  createdAt: { type: Date, default: Date.now },
  updateCount: { type: Number, min: 0, default: 0 },
}, { _id: false });
const progressUpdateSchema = new Schema<ITicketProgressUpdate>({
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  summary: { type: String, required: true, trim: true, maxlength: 240 },
  completed: { type: String, trim: true, maxlength: 500, default: '' },
  nextAction: { type: String, trim: true, maxlength: 300, default: '' },
  blockers: { type: String, trim: true, maxlength: 300, default: '' },
  assistanceNeeded: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, required: true },
}, { _id: true });
const assistanceOfferSchema = new Schema<ITicketAssistanceOffer>({
  agent: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, required: true, trim: true, maxlength: 500 },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending', required: true },
  createdAt: { type: Date, default: Date.now, required: true },
  respondedAt: { type: Date },
  respondedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  acceptedFor: { type: Schema.Types.ObjectId, ref: 'User' },
}, { _id: true });
const ticketSchema = new Schema<ITicket>({
  title: { type: String, required: true, trim: true, maxlength: 140 },
  description: { type: String, required: true, trim: true, maxlength: 10000 },
  category: { type: String, required: true, trim: true, maxlength: 60 },
  priority: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Medium', required: true },
  status: { type: String, enum: ['Open', 'In Progress', 'Ready for review', 'Resolved', 'Closed'], default: 'Open', required: true },
  clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  workCompletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  workCompletedAt: { type: Date, default: null },
  creditedAgent: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  resolutionConfirmedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  resolutionConfirmedAt: { type: Date, default: null },
  proposals: { type: [proposalSchema], default: [] },
  progressUpdates: { type: [progressUpdateSchema], default: [] },
  assistanceOffers: { type: [assistanceOfferSchema], default: [] },
  agentRating: { type: Number, min: 1, max: 5 },
  dueDate: { type: Date, default: null, index: true },
  submissionId: { type: String, unique: true, sparse: true, select: false },
  comments: { type: [commentSchema], default: [] },
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });
ticketSchema.index({ status: 1, priority: 1, createdAt: -1 });
ticketSchema.index({ status: 1, creditedAgent: 1 });
ticketSchema.index({ updatedAt: -1, _id: -1 });
ticketSchema.index({ clientId: 1, updatedAt: -1, _id: -1 });
ticketSchema.index({ assignedTo: 1, updatedAt: -1, _id: -1 });
ticketSchema.virtual('teamCollaborators').get(function (this: ITicket) {
  const override = this.$locals.teamCollaborators as Array<{ id: string; name: string; avatarUrl?: string }> | undefined;
  if (override) return override;
  const ownerId = reference(this.assignedTo);
  if (!ownerId) return [];
  const seen = new Set<string>();
  return this.assistanceOffers.filter(offer => offer.status === 'accepted' && reference(offer.acceptedFor) === ownerId).flatMap(offer => {
    const agent = offer.agent as unknown as { _id?: Types.ObjectId; id?: string; name?: string; avatarUrl?: string };
    const id = agent?._id?.toString() || agent?.id || agent?.toString();
    if (!id || id === ownerId || seen.has(id) || !agent?.name) return [];
    seen.add(id);
    return [{ id, name: agent.name, ...(agent.avatarUrl ? { avatarUrl: agent.avatarUrl } : {}) }];
  });
});
ticketSchema.virtual('teamCollaborators').set(function (this: ITicket, value: Array<{ id: string; name: string; avatarUrl?: string }>) {
  this.$locals.teamCollaborators = value;
});
function reference(value: unknown): string {
  if (value && typeof value === 'object' && '_id' in value) return String((value as { _id: unknown })._id);
  return value == null ? '' : String(value);
}
export const Ticket = model<ITicket>('Ticket', ticketSchema);
