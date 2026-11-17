import pg from 'pg';
import { readFile } from 'node:fs/promises';
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL ?? 'postgres://exercise:exercise@localhost:55432/exercise'});
const client = await pool.connect();
try {
  // Two app instances can start together: let only one run the schema at a time.
  await client.query('SELECT pg_advisory_lock(724001)');
  await client.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
} finally {
  await client.query('SELECT pg_advisory_unlock(724001)').catch(() => {});
  client.release();
  await pool.end();
}
