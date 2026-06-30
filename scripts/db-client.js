#!/usr/bin/env node
/**
 * Shared pg client for maintenance scripts (uses DATABASE_URL or DATABASE_URL_DIRECT).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    const url =
      process.env.DATABASE_URL_DIRECT?.trim() ||
      process.env.DATABASE_URL?.trim();
    if (!url) {
      throw new Error('Set DATABASE_URL or DATABASE_URL_DIRECT');
    }
    pool = new Pool({ connectionString: url, prepare: false });
  }
  return pool;
}

async function query(sql, params = []) {
  const result = await getPool().query(sql, params);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { query, closePool, getPool };
