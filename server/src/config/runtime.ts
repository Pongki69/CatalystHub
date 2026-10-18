import { connectDatabase } from './db';
import { resetGuestDemoIfDue } from '../services/guestDemo';

let ready: Promise<void> | undefined;

function databaseName(uri: string): { host: string; name: string } {
  const parsed = new URL(uri);
  return { host: parsed.host.toLowerCase(), name: decodeURIComponent(parsed.pathname.replace(/^\//, '')) };
}

function guestDatabaseUri(mainUri: string): string {
  const explicitGuestUri = process.env.MONGODB_GUEST_URI;
  if (explicitGuestUri) return explicitGuestUri;
  const parsed = new URL(mainUri);
  const mainName = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'catalysthub';
  parsed.pathname = `/${mainName}_guest`;
  return parsed.toString();
}

async function connectRuntime(): Promise<void> {
  const mainUri = process.env.MONGODB_URI;
  if (!mainUri || !process.env.JWT_SECRET) throw new Error('MONGODB_URI and JWT_SECRET are required.');

  if (process.env.GUEST_MODE === 'true') {
    const guestUri = guestDatabaseUri(mainUri);
    const main = databaseName(mainUri);
    const guest = databaseName(guestUri);
    if (!guest.name || !guest.name.toLowerCase().includes('guest')) {
      throw new Error('Guest database name must include "guest" as a safety check.');
    }
    if (main.host === guest.host && main.name.toLowerCase() === guest.name.toLowerCase()) {
      throw new Error('Guest API refused to use the main application database.');
    }
    process.env.GUEST_AGENT_ID = process.env.GUEST_AGENT_ID || '65f000000000000000000002';
    process.env.JWT_SECRET = process.env.JWT_GUEST_SECRET || `${process.env.JWT_SECRET}:catalysthub-guest-only`;
    await connectDatabase(guestUri);
    await resetGuestDemoIfDue();
    return;
  }

  await connectDatabase(mainUri);
}

export function ensureRuntimeReady(): Promise<void> {
  if (!ready) {
    ready = connectRuntime().catch(error => {
      ready = undefined;
      throw error;
    });
  }
  return ready;
}
