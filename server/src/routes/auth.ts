import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { User } from '../models/User';
import { EmailVerification } from '../models/EmailVerification';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { trackEvent } from '../services/events';

export const authRouter = Router();
const registerSchema = z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().email(), password: z.string().min(8).max(100), confirmPassword: z.string().min(8).max(100), role: z.enum(['client', 'agent']).default('client') });
const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1) });
function issueToken(id: string): string { return jwt.sign({ sub: id }, process.env.JWT_SECRET!, { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'] }); }
const verificationTokenSecret = () => process.env.EMAIL_OTP_SECRET!;
const hashCode = (email: string, code: string) => createHmac('sha256', verificationTokenSecret()).update(`${email}:${code}`).digest('hex');
const emailSchema = z.object({ email: z.string().trim().email().max(254) });
const emailVerificationConfigured = () => Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD && process.env.EMAIL_OTP_SECRET);
let gmailTransporter: ReturnType<typeof nodemailer.createTransport> | undefined;
function getGmailTransporter(): ReturnType<typeof nodemailer.createTransport> {
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, ''),
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return gmailTransporter;
}
const emailCodeWindows = new Map<string, { startedAt: number; requests: number }>();
function isEmailCodeRateLimited(ip: string, now: number): boolean {
  const windowMs = 15 * 60 * 1000;
  const current = emailCodeWindows.get(ip);
  if (!current || now - current.startedAt >= windowMs) { emailCodeWindows.set(ip, { startedAt: now, requests: 1 }); return false; }
  if (current.requests >= 5) return true;
  current.requests += 1;
  return false;
}

authRouter.post('/email-code', async (req, res, next) => {
  try {
    if (process.env.GUEST_MODE === 'true') { res.status(403).json({ success: false, message: 'Account registration is disabled in the guest demo.' }); return; }
    if (!emailVerificationConfigured()) { res.status(503).json({ success: false, message: 'Email verification is not configured yet. Please contact the site administrator.' }); return; }
    if (isEmailCodeRateLimited(req.ip || 'unknown', Date.now())) { res.status(429).json({ success: false, message: 'Too many verification requests. Please try again in 15 minutes.' }); return; }
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Enter a valid email address.' }); return; }
    const email = parsed.data.email.toLowerCase();
    if (await User.exists({ email })) { res.status(409).json({ success: false, message: 'An account with this email already exists.' }); return; }
    const now = new Date();
    const existing = await EmailVerification.findOne({ email });
    if (existing && existing.resendAt > now) {
      res.status(429).json({ success: false, message: 'Please wait before requesting another code.', retryAfterSeconds: Math.ceil((existing.resendAt.getTime() - now.getTime()) / 1000) }); return;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    await EmailVerification.findOneAndUpdate({ email }, { email, codeHash: hashCode(email, code), expiresAt, resendAt: new Date(now.getTime() + 60_000), attempts: 0 }, { upsert: true, new: true, setDefaultsOnInsert: true });

    try {
      await getGmailTransporter().sendMail({
        from: `CatalystHub <${process.env.GMAIL_USER}>`,
        to: email,
        subject: 'Your CatalystHub verification code',
        text: `Your CatalystHub verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;color:#173528;max-width:520px"><h2>Verify your email</h2><p>Enter this code to finish creating your CatalystHub account:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p></div>`,
      });
    } catch (error) {
      await EmailVerification.deleteOne({ email });
      console.error('Gmail verification email delivery failed:', error);
      res.status(502).json({ success: false, message: 'We could not send the verification email. Please try again shortly.' }); return;
    }
    res.json({ success: true, data: { message: 'Verification code sent. Check your inbox and spam folder.' } });
  } catch (error) { next(error); }
});

authRouter.post('/verify-email', async (req, res, next) => {
  try {
    if (process.env.GUEST_MODE === 'true') { res.status(403).json({ success: false, message: 'Account registration is disabled in the guest demo.' }); return; }
    if (!emailVerificationConfigured()) { res.status(503).json({ success: false, message: 'Email verification is not configured yet. Please contact the site administrator.' }); return; }
    const parsed = z.object({ email: z.string().trim().email().max(254), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Enter your email address and the six-digit code.' }); return; }
    const email = parsed.data.email.toLowerCase();
    const record = await EmailVerification.findOne({ email }).select('+codeHash');
    if (!record || record.expiresAt <= new Date()) { res.status(400).json({ success: false, message: 'That code has expired or was not requested. Request a new code.' }); return; }
    if (record.attempts >= 5) { res.status(429).json({ success: false, message: 'Too many incorrect attempts. Request a new code.' }); return; }
    const submittedHash = Buffer.from(hashCode(email, parsed.data.code), 'hex');
    const storedHash = Buffer.from(record.codeHash, 'hex');
    if (submittedHash.length !== storedHash.length || !timingSafeEqual(submittedHash, storedHash)) {
      record.attempts += 1;
      await record.save();
      res.status(400).json({ success: false, message: `That code is incorrect. ${5 - record.attempts} attempts remaining.` }); return;
    }
    await EmailVerification.deleteOne({ _id: record._id });
    const verificationToken = jwt.sign({ purpose: 'email-registration', email }, verificationTokenSecret(), { expiresIn: '15m' });
    res.json({ success: true, data: { verificationToken } });
  } catch (error) { next(error); }
});

 const safeUser = (user: { _id?: unknown; id?: string; name: string; email: string; role: string; company?: string; bio?: string; jobTitle?: string; location?: string; website?: string; avatarUrl?: string; coverUrl?: string }) => ({ id: String(user._id ?? user.id), name: user.name, email: user.email, role: user.role, company: user.company || '', bio: user.bio || '', jobTitle: user.jobTitle || '', location: user.location || '', website: user.website || '', avatarUrl: user.avatarUrl || '', coverUrl: user.coverUrl || '' });
authRouter.post('/register', async (req, res, next) => {
  try {
    if (process.env.GUEST_MODE === 'true') { res.status(403).json({ success: false, message: 'Account registration is disabled in the guest demo.' }); return; }
    if (!emailVerificationConfigured()) { res.status(503).json({ success: false, message: 'Email verification is not configured yet. Please contact the site administrator.' }); return; }
    const parsed = registerSchema.extend({ verificationToken: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: parsed.error.issues[0].message }); return; }
    const { name, email: submittedEmail, password, role, verificationToken } = parsed.data;
    if (password !== parsed.data.confirmPassword) { res.status(400).json({ success: false, message: 'Passwords do not match.' }); return; }
    const email = submittedEmail.toLowerCase();
    let verifiedEmail: string;
    try {
      const claims = jwt.verify(verificationToken, verificationTokenSecret()) as jwt.JwtPayload;
      if (claims.purpose !== 'email-registration' || typeof claims.email !== 'string') throw new Error('Invalid verification token.');
      verifiedEmail = claims.email;
    } catch {
      res.status(400).json({ success: false, message: 'Verify your email before creating an account.' }); return;
    }
    if (verifiedEmail !== email) { res.status(400).json({ success: false, message: 'The verified email does not match this account email.' }); return; }
    if (await User.exists({ email: email.toLowerCase() })) { res.status(409).json({ success: false, message: 'An account with this email already exists.' }); return; }
    const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 12), role, approvalStatus: role === 'agent' ? 'pending' : 'approved' });
    if (role === 'agent') {
      const admins = await User.find({ role: 'admin' }).select('_id');
      await trackEvent({ actorId: user.id, action: 'agent_registered', summary: `${user.name} registered for a ${role} account`, participantIds: [user.id], details: { email: user.email, role }, notification: { type: 'agent_pending', title: 'Agent approval needed', message: `${user.name} registered as an agent and is waiting for approval.`, recipientIds: admins.map(admin => admin._id), link: '/users' } });
    } else {
      await trackEvent({ actorId: user.id, action: 'client_registered', summary: `${user.name} registered for a ${role} account`, participantIds: [user.id], details: { email: user.email, role } });
    }
    if (role === 'agent') { res.status(201).json({ success: true, data: { user: safeUser(user), pendingApproval: true } }); return; }
    res.status(201).json({ success: true, data: { user: safeUser(user), token: issueToken(user.id), pendingApproval: false } });
  } catch (error) { next(error); }
});
authRouter.post('/demo-login', async (req, res, next) => {
  try {
    if (process.env.GUEST_MODE !== 'true') { res.status(404).json({ success: false, message: 'Not found.' }); return; }
    const parsed = z.object({ role: z.enum(['client', 'agent']) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Choose a guest role.' }); return; }
    const email = parsed.data.role === 'client' ? 'guest.client@catalysthub.demo' : 'guest.agent@catalysthub.demo';
    const user = await User.findOne({ email, role: parsed.data.role, approvalStatus: 'approved' });
    if (!user) { res.status(503).json({ success: false, message: 'The guest workspace is resetting. Please try again shortly.' }); return; }
    res.json({ success: true, data: { user: safeUser(user), token: issueToken(user.id), isGuest: true } });
  } catch (error) { next(error); }
});
authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'Enter a valid email and password.' }); return; }
    const user = await User.findOne({ email: parsed.data.email.toLowerCase() }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) { res.status(401).json({ success: false, message: 'Email or password is incorrect.' }); return; }
    if (user.isBanned) { res.status(403).json({ success: false, message: 'This account is suspended. Contact the agency admin.' }); return; }
    if (user.role === 'agent' && user.approvalStatus !== 'approved') { res.status(403).json({ success: false, message: user.approvalStatus === 'rejected' ? 'Your agent account was not approved. Contact the agency admin.' : 'Your agent account is awaiting admin approval.' }); return; }
    res.json({ success: true, data: { user: safeUser(user), token: issueToken(user.id) } });
  } catch (error) { next(error); }
});
authRouter.get('/me', authenticate, (req: AuthRequest, res) => { res.json({ success: true, data: { user: req.user } }); });
