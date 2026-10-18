import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { authRouter } from './routes/auth';
import { ticketRouter } from './routes/tickets';
import { adminRouter } from './routes/admin';
import { notificationRouter } from './routes/notifications';
import { messageRouter } from './routes/messages';
import { profileRouter } from './routes/profile';
import { callRouter } from './routes/calls';
import { errorHandler, notFound } from './middleware/errors';
import { ensureRuntimeReady } from './config/runtime';

export const app = express();
// Vercel's Express framework preset detects this file as the app entry point.
export default app;
// Vercel runs this app as a serverless function, so establish its database
// connection on demand and reuse it for warm invocations. Local API processes
// continue to connect in their existing entry points.
app.use((req, res, next) => {
  if (!process.env.VERCEL) return next();
  void ensureRuntimeReady().then(() => next(), next);
});
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));
// Attachments are base64 encoded in MongoDB documents, so the JSON request
// limit must allow one 5 MiB file plus its encoding overhead.
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.get('/api/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));
app.use('/api/auth', authRouter);
app.use('/api/tickets', ticketRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/messages', messageRouter);
app.use('/api/profile', profileRouter);
app.use('/api/calls', callRouter);
app.use(notFound);
app.use(errorHandler);
