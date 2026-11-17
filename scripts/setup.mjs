import pg from 'pg';
import { readFile } from 'node:fs/promises';
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL ?? 'postgres://exercise:exercise@localhost:55432/exercise'});
try { await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8')); }
finally { await pool.end(); }
