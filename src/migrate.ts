import 'dotenv/config';
import { postgres } from './platform/database.js';
import { migrate } from './platform/migrations.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = postgres(process.env.DATABASE_URL);
try { await migrate(db); console.log('Database migrations verified and applied.'); }
finally { await db.close(); }
