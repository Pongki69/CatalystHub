import { Schema, model, type Document, type Types } from 'mongoose';

export type AttachmentKind = 'image' | 'audio' | 'file';
export interface IMessageAttachment { kind: AttachmentKind; name: string; mimeType: string; size: number; dataUrl: string; }
export type MessageReactionEmoji = '👍' | '❤️' | '😂' | '😮' | '😢' | '🙏';
export interface IMessageReaction { user: Types.ObjectId; emoji: MessageReactionEmoji; }
export interface IThreadMessage extends Document {
  ticket: Types.ObjectId; sender: Types.ObjectId; message: string; attachment?: IMessageAttachment; attachments?: IMessageAttachment[]; reactions: IMessageReaction[]; editedAt?: Date; deletedAt?: Date; deletedBy?: Types.ObjectId; createdAt: Date; submissionId?: string;
}
const attachmentSchema = new Schema<IMessageAttachment>({
  kind: { type: String, enum: ['image', 'audio', 'file'], required: true },
  name: { type: String, required: true, maxlength: 120 },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  dataUrl: { type: String, required: true },
}, { _id: false });
const reactionSchema = new Schema<IMessageReaction>({ user: { type: Schema.Types.ObjectId, ref: 'User', required: true }, emoji: { type: String, enum: ['👍', '❤️', '😂', '😮', '😢', '🙏'], required: true } }, { _id: false });
const threadMessageSchema = new Schema<IThreadMessage>({
  ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true, index: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, trim: true, maxlength: 20000, default: '' },
  attachment: { type: attachmentSchema },
  attachments: { type: [attachmentSchema], default: undefined },
  reactions: { type: [reactionSchema], default: [] },
  editedAt: { type: Date },
  deletedAt: { type: Date },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  submissionId: { type: String, unique: true, sparse: true, select: false },
}, { timestamps: { createdAt: true, updatedAt: false } });
threadMessageSchema.index({ ticket: 1, createdAt: 1 });
export const ThreadMessage = model<IThreadMessage>('ThreadMessage', threadMessageSchema);
