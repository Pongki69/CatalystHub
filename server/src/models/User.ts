import { Schema, model, type Document } from 'mongoose';

export type UserRole = 'client' | 'agent' | 'admin';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export interface IUser extends Document {
  name: string; email: string; passwordHash: string; role: UserRole; approvalStatus: ApprovalStatus; company?: string; bio?: string; jobTitle?: string; location?: string; website?: string; avatarUrl?: string; coverUrl?: string; isBanned: boolean; bannedAt?: Date; banReason?: string; createdAt: Date;
}
const userSchema = new Schema<IUser>({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['client', 'agent', 'admin'], default: 'client', required: true },
  approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', required: true },
  company: { type: String, trim: true, maxlength: 120, default: '' },
  bio: { type: String, trim: true, maxlength: 500, default: '' },
  jobTitle: { type: String, trim: true, maxlength: 100, default: '' },
  location: { type: String, trim: true, maxlength: 120, default: '' },
  website: { type: String, trim: true, maxlength: 200, default: '' },
  avatarUrl: { type: String, maxlength: 700000 },
  coverUrl: { type: String, maxlength: 1400000 },
  isBanned: { type: Boolean, default: false, index: true },
  bannedAt: { type: Date },
  banReason: { type: String, trim: true, maxlength: 240 },
}, { timestamps: { createdAt: true, updatedAt: false } });
export const User = model<IUser>('User', userSchema);
