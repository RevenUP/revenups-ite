const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não configurada — defina a connection string do Postgres no ambiente.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
});

const STATUSES = ['novo', 'em_contato', 'qualificado', 'cliente', 'descartado'];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT NOT NULL,
      empresa TEXT DEFAULT '',
      mensagem TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'novo',
      notas TEXT DEFAULT '',
      origem TEXT NOT NULL DEFAULT 'site',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      sincronizado_em TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS leads_criado_em_idx ON leads (criado_em DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS leads_sincronizado_em_idx ON leads (sincronizado_em);`);
}

module.exports = { pool, init, STATUSES };
