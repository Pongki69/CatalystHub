import { Schema, model, type Document, type Types } from 'mongoose';

export interface IDirectConversation extends Document {
  participants: Types.ObjectId[]; participantKey: string; groupName?: string; lastMessageAt: Date; createdAt: Date; updatedAt: Date;
}
const directConversationSchema = new Schema<IDirectConversation>({
  participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
  participantKey: { type: String, required: true, unique: true },
  groupName: { type: String, trim: true, maxlength: 80 },
  lastMessageAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });
directConversationSchema.index({ participants: 1, lastMessageAt: -1, _id: -1 });
export const DirectConversation = model<IDirectConversation>('DirectConversation', directConversationSchema);
