import { Schema, model, type Document, type Types } from 'mongoose';

export interface ITeamMessage extends Document {
  ticket: Types.ObjectId;
  sender: Types.ObjectId;
  message: string;
  createdAt: Date;
}

const teamMessageSchema = new Schema<ITeamMessage>({
  ticket: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true, index: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
}, { timestamps: { createdAt: true, updatedAt: false } });

teamMessageSchema.index({ ticket: 1, createdAt: -1, _id: -1 });

export const TeamMessage = model<ITeamMessage>('TeamMessage', teamMessageSchema);
