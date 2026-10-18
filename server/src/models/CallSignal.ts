import { Schema, model, type Document, type Types } from 'mongoose';

export type CallSignalKind = 'offer' | 'answer' | 'ice';
export interface ICallSignal extends Document {
  call: Types.ObjectId;
  sender: Types.ObjectId;
  recipient: Types.ObjectId;
  kind: CallSignalKind;
  payload: Record<string, unknown>;
  createdAt: Date;
}
const callSignalSchema = new Schema<ICallSignal>({
  call: { type: Schema.Types.ObjectId, ref: 'CallSession', required: true, index: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['offer', 'answer', 'ice'], required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 },
});
callSignalSchema.index({ call: 1, recipient: 1, _id: 1 });
export const CallSignal = model<ICallSignal>('CallSignal', callSignalSchema);
