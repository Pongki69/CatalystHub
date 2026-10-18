import { Schema, model, type Document, type Types } from 'mongoose';
import { type IMessageAttachment, type IMessageReaction } from './ThreadMessage';

export interface IMessageCallRecord { callId: string; mode: 'audio' | 'video'; initiator: Types.ObjectId; participants: Types.ObjectId[]; status: 'ringing' | 'active' | 'completed' | 'declined' | 'canceled' | 'missed'; result?: 'completed' | 'declined' | 'canceled' | 'missed'; durationSeconds: number; }

export interface IDirectMessage extends Document {
  conversation: Types.ObjectId; sender: Types.ObjectId; message: string; attachment?: IMessageAttachment; attachments?: IMessageAttachment[]; callRecord?: IMessageCallRecord; reactions: IMessageReaction[]; editedAt?: Date; deletedAt?: Date; deletedBy?: Types.ObjectId; createdAt: Date; submissionId?: string;
}
const attachmentSchema = new Schema<IMessageAttachment>({
  kind: { type: String, enum: ['image', 'audio', 'file'], required: true }, name: { type: String, required: true, maxlength: 120 },
  mimeType: { type: String, required: true }, size: { type: Number, required: true }, dataUrl: { type: String, required: true },
}, { _id: false });
const reactionSchema = new Schema<IMessageReaction>({ user: { type: Schema.Types.ObjectId, ref: 'User', required: true }, emoji: { type: String, enum: ['👍', '❤️', '😂', '😮', '😢', '🙏'], required: true } }, { _id: false });
const directMessageSchema = new Schema<IDirectMessage>({
  conversation: { type: Schema.Types.ObjectId, ref: 'DirectConversation', required: true, index: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, trim: true, maxlength: 20000, default: '' },
  attachment: { type: attachmentSchema },
  attachments: { type: [attachmentSchema], default: undefined },
  callRecord: { type: Schema.Types.Mixed },
  reactions: { type: [reactionSchema], default: [] },
  editedAt: { type: Date },
  deletedAt: { type: Date },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  submissionId: { type: String, unique: true, sparse: true, select: false },
}, { timestamps: { createdAt: true, updatedAt: false } });
directMessageSchema.index({ conversation: 1, createdAt: -1, _id: -1 });
export const DirectMessage = model<IDirectMessage>('DirectMessage', directMessageSchema);
