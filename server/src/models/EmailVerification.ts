import mongoose, { Schema } from 'mongoose';

export interface EmailVerificationRecord extends mongoose.Document {
  email: string;
  codeHash: string;
  expiresAt: Date;
  resendAt: Date;
  attempts: number;
}

const emailVerificationSchema = new Schema<EmailVerificationRecord>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  codeHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  resendAt: { type: Date, required: true },
  attempts: { type: Number, required: true, default: 0 },
}, { timestamps: true, collection: 'emailverifications' });

export const EmailVerification = mongoose.model<EmailVerificationRecord>('EmailVerification', emailVerificationSchema);
