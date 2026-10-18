import 'dotenv/config';
import mongoose from 'mongoose';
import { app } from './app';
import { connectDatabase } from './config/db';
import { resetGuestDemoIfDue } from './services/guestDemo';

function getDatabase(uri: string): { host: string; name: string } {
  const parsed = new URL(uri);
  return { host: parsed.host.toLowerCase(), name: decodeURIComponent(parsed.pathname.replace(/^\//, '')) };
}

function guestDatabaseUri(): string {
  const mainUri = process.env.MONGODB_URI;
  if (!mainUri) throw new Error('MONGODB_URI is required to verify database separation.');
  const main = getDatabase(mainUri);
  const mainName = main.name || 'catalysthub';
  const explicitGuestUri = process.env.MONGODB_GUEST_URI;
  if (explicitGuestUri) return explicitGuestUri;
  const parsed = new URL(mainUri);
  parsed.pathname = `/${mainName}_guest`;
  return parsed.toString();
}

async function start(): Promise<void> {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required.');
  process.env.GUEST_MODE = 'true';
  process.env.GUEST_AGENT_ID = '65f000000000000000000002';
  process.env.JWT_SECRET = process.env.JWT_GUEST_SECRET || `${process.env.JWT_SECRET}:catalysthub-guest-only`;
  const mainUri = process.env.MONGODB_URI!;
  const guestUri = guestDatabaseUri();
  const mainDb = getDatabase(mainUri);
  const guestDb = getDatabase(guestUri);
  if (!guestDb.name.toLowerCase().includes('guest')) throw new Error('Guest database name must include "guest" as a safety check.');
  if (mainDb.host === guestDb.host && mainDb.name.toLowerCase() === guestDb.name.toLowerCase()) throw new Error('Guest API refused to use the main application database.');
  if (!guestDb.name) throw new Error('MONGODB_GUEST_URI must include a guest database name.');
  await connectDatabase(guestUri);
  await resetGuestDemoIfDue();
  const port = Number(process.env.GUEST_PORT || 5001);
  app.listen(port, () => console.log(`CatalystHub guest API listening on http://localhost:${port} (MongoDB: ${mongoose.connection.name})`));
  const scheduleNextReset = () => {
    const now = new Date();
    const nextUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const delay = Math.max(1000, nextUtcMidnight.getTime() - now.getTime());
    setTimeout(async () => {
      try { await resetGuestDemoIfDue(); }
      catch (error) { console.error('Guest demo daily reset failed:', error); }
      scheduleNextReset();
    }, delay).unref();
  };
  scheduleNextReset();
}

start().catch(error => { console.error('Failed to start CatalystHub guest API:', error); process.exit(1); });
