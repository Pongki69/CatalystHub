import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User, type UserRole } from '../models/User';

export interface AuthRequest extends Request { user?: { id: string; role: UserRole; name: string; email: string; company?: string; bio?: string; jobTitle?: string; location?: string; website?: string; avatarUrl?: string; coverUrl?: string }; }
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.token;
  if (!token) { res.status(401).json({ success: false, message: 'Authentication required.' }); return; }

  let payload: { sub: string };
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as { sub: string };
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    return;
  }

  try {
    const user = await User.findById(payload.sub).select('name email role approvalStatus company bio jobTitle location website avatarUrl coverUrl isBanned');
    if (!user) { res.status(401).json({ success: false, message: 'Account not found.' }); return; }
    if (user.isBanned) { res.status(403).json({ success: false, message: 'This account is suspended. Contact the agency admin.' }); return; }
    if (user.role === 'agent' && user.approvalStatus !== 'approved') { res.status(403).json({ success: false, message: 'Your agent account is awaiting admin approval.' }); return; }
    req.user = { id: user.id, role: user.role, name: user.name, email: user.email, company: user.company, bio: user.bio, jobTitle: user.jobTitle, location: user.location, website: user.website, avatarUrl: user.avatarUrl, coverUrl: user.coverUrl };
    next();
  } catch (error) {
    // A database outage is a server failure, not evidence of a bad credential.
    next(error);
  }
}
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') { res.status(403).json({ success: false, message: 'Admin access required.' }); return; }
  next();
}
export function requireStaff(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin' && req.user?.role !== 'agent') { res.status(403).json({ success: false, message: 'Agency staff access required.' }); return; }
  next();
}
