import { Schema, model, type Document, type Types } from 'mongoose';

export type CallMode = 'audio' | 'video';
export type CallState = 'ringing' | 'active' | 'ended';
export type CallResult = 'completed' | 'declined' | 'canceled' | 'missed';
export interface ICallSession extends Document {
  conversation: Types.ObjectId;
  initiator: Types.ObjectId;
  participants: Types.ObjectId[];
  acceptedBy: Types.ObjectId[];
  declinedBy: Types.ObjectId[];
  leftBy: Types.ObjectId[];
  mode: CallMode;
  state: CallState;
  result?: CallResult;
  createdAt: Date;
  connectedAt?: Date;
  endedAt?: Date;
  lastActivityAt: Date;
}
const callSessionSchema = new Schema<ICallSession>({
  conversation: { type: Schema.Types.ObjectId, ref: 'DirectConversation', required: true, index: true },
  initiator: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
  acceptedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  declinedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  leftBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  mode: { type: String, enum: ['audio', 'video'], required: true },
  state: { type: String, enum: ['ringing', 'active', 'ended'], default: 'ringing', index: true },
  result: { type: String, enum: ['completed', 'declined', 'canceled', 'missed'] },
  connectedAt: Date,
  endedAt: Date,
  lastActivityAt: { type: Date, default: Date.now, index: true },
}, { timestamps: { createdAt: true, updatedAt: true } });
callSessionSchema.index({ participants: 1, state: 1, createdAt: -1 });
export const CallSession = model<ICallSession>('CallSession', callSessionSchema);
