import 'dotenv/config';
import { app } from './app';
import { connectDatabase } from './config/db';

async function start(): Promise<void> {
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) throw new Error('MONGODB_URI and JWT_SECRET are required.');
  await connectDatabase(process.env.MONGODB_URI);
  const port = Number(process.env.PORT || 5000);
  app.listen(port, () => console.log(`CatalystHub API listening on http://localhost:${port}`));
}
start().catch(error => { console.error('Failed to start CatalystHub API:', error); process.exit(1); });
