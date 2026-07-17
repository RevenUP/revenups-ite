require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { z } = require('zod');
const { pool, init, STATUSES } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const LEADS_SYNC_KEY = process.env.LEADS_SYNC_KEY || '';

const STATUS_LABEL = {
  novo: 'Novo',
  em_contato: 'Em contato',
  qualificado: 'Qualificado',
  cliente: 'Cliente',
  descartado: 'Descartado',
};

app.set('trust proxy', 1);
app.use(morgan('combined'));
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  })
);
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: true, limit: '20kb' }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8, // 8 horas
    },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Rate limiting ----------
const limiteContato = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------- Validação ----------
const contatoSchema = z.object({
  nome: z.string().trim().min(2, 'Nome muito curto').max(200),
  email: z.string().trim().email('E-mail inválido').max(200),
  empresa: z.string().trim().max(200).optional().default(''),
  mensagem: z.string().trim().min(5, 'Mensagem muito curta').max(4000),
});

// ---------- E-mail (opcional — só ativa se SMTP_* estiver configurado) ----------
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function notificarNovoLead(lead) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.CONTATO_DESTINO || 'Revenup001@gmail.com',
      subject: `Novo lead do site — ${lead.nome}`,
      text: `Nome: ${lead.nome}\nE-mail: ${lead.email}\nEmpresa: ${lead.empresa || '-'}\n\nMensagem:\n${lead.mensagem}`,
    });
  } catch (erro) {
    console.error('Falha ao enviar e-mail de notificação de lead:', erro.message);
  }
}

// ---------- Health check ----------
app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (erro) {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

// ---------- API pública: formulário de contato ----------
app.post('/api/contato', limiteContato, async (req, res) => {
  const resultado = contatoSchema.safeParse(req.body || {});
  if (!resultado.success) {
    return res.status(400).json({ erro: resultado.error.issues[0]?.message || 'Dados inválidos.' });
  }

  const { nome, email, empresa, mensagem } = resultado.data;
  const id = crypto.randomUUID();

  try {
    await pool.query(
      `INSERT INTO leads (id, nome, email, empresa, mensagem, status, origem)
       VALUES ($1, $2, $3, $4, $5, 'novo', 'site')`,
      [id, nome, email, empresa, mensagem]
    );
  } catch (erro) {
    console.error('Falha ao salvar lead:', erro.message);
    return res.status(500).json({ erro: 'Não foi possível salvar sua mensagem agora. Tente novamente.' });
  }

  notificarNovoLead({ nome, email, empresa, mensagem });
  res.status(201).json({ ok: true });
});

// ---------- API protegida: sincronização com o Cérebro (Workspace Entrega) ----------
app.get('/api/sync/leads', async (req, res) => {
  if (!LEADS_SYNC_KEY) {
    return res.status(503).json({ erro: 'Sincronização não configurada.' });
  }
  const chave = req.get('x-sync-key');
  const chaveValida =
    chave &&
    chave.length === LEADS_SYNC_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(chave), Buffer.from(LEADS_SYNC_KEY));

  if (!chaveValida) {
    return res.status(401).json({ erro: 'Chave de sincronização inválida.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, nome, email, empresa, mensagem, status, origem, criado_em
       FROM leads WHERE sincronizado_em IS NULL ORDER BY criado_em ASC LIMIT 200`
    );
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      await client.query(`UPDATE leads SET sincronizado_em = now() WHERE id = ANY($1::uuid[])`, [ids]);
    }
    await client.query('COMMIT');
    res.json({ leads: rows });
  } catch (erro) {
    await client.query('ROLLBACK');
    console.error('Falha na sincronização de leads:', erro.message);
    res.status(500).json({ erro: 'Falha ao buscar leads.' });
  } finally {
    client.release();
  }
});

// ---------- Admin: autenticação ----------
function exigirLogin(req, res, next) {
  if (req.session && req.session.autenticado) return next();
  return res.redirect('/admin');
}

function verificarCsrf(req, res, next) {
  const token = req.body && req.body._csrf;
  const esperado = req.session && req.session.csrfToken;
  if (
    !token ||
    !esperado ||
    token.length !== esperado.length ||
    !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado))
  ) {
    return res.status(403).send('Sessão expirada ou inválida. Volte e tente novamente.');
  }
  next();
}

app.get('/admin', (req, res) => {
  if (req.session && req.session.autenticado) return res.redirect('/admin/leads');
  res.type('html').send(paginaLogin());
});

app.post('/admin/login', limiteLogin, (req, res) => {
  const { senha } = req.body || {};

  if (!ADMIN_PASSWORD) {
    return res.type('html').send(paginaLogin('Painel não configurado — defina ADMIN_PASSWORD no servidor.'));
  }

  const senhaBuffer = Buffer.from(String(senha || ''));
  const esperadaBuffer = Buffer.from(ADMIN_PASSWORD);
  const senhaCorreta =
    senhaBuffer.length === esperadaBuffer.length && crypto.timingSafeEqual(senhaBuffer, esperadaBuffer);

  if (!senhaCorreta) {
    return res.type('html').send(paginaLogin('Senha incorreta.'));
  }

  req.session.autenticado = true;
  req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.redirect('/admin/leads');
});

app.post('/admin/logout', exigirLogin, verificarCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

// ---------- Admin: painel de leads (busca, filtro, paginação) ----------
app.get('/admin/leads', exigirLogin, async (req, res) => {
  const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
  const tamanhoPagina = 20;
  const busca = String(req.query.q || '').trim();
  const statusFiltro = STATUSES.includes(req.query.status) ? req.query.status : '';

  const condicoes = [];
  const valores = [];

  if (busca) {
    valores.push(`%${busca}%`);
    condicoes.push(`(nome ILIKE $${valores.length} OR email ILIKE $${valores.length} OR empresa ILIKE $${valores.length})`);
  }
  if (statusFiltro) {
    valores.push(statusFiltro);
    condicoes.push(`status = $${valores.length}`);
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const totalResultado = await pool.query(`SELECT COUNT(*)::int AS total FROM leads ${where}`, valores);
  const total = totalResultado.rows[0].total;
  const totalPaginas = Math.max(1, Math.ceil(total / tamanhoPagina));
  const offset = (pagina - 1) * tamanhoPagina;

  valores.push(tamanhoPagina, offset);
  const { rows: leads } = await pool.query(
    `SELECT * FROM leads ${where} ORDER BY criado_em DESC LIMIT $${valores.length - 1} OFFSET $${valores.length}`,
    valores
  );

  const contadorStatus = await pool.query(
    `SELECT status, COUNT(*)::int AS total FROM leads GROUP BY status`
  );
  const contagens = Object.fromEntries(contadorStatus.rows.map((r) => [r.status, r.total]));

  res.type('html').send(
    paginaLeads({ leads, total, pagina, totalPaginas, busca, statusFiltro, contagens, csrfToken: req.session.csrfToken })
  );
});

app.get('/admin/leads/export.csv', exigirLogin, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM leads ORDER BY criado_em DESC`);
  const cabecalho = ['Nome', 'E-mail', 'Empresa', 'Mensagem', 'Status', 'Notas', 'Recebido em'];
  const linhas = rows.map((l) =>
    [l.nome, l.email, l.empresa, l.mensagem, STATUS_LABEL[l.status] || l.status, l.notas, new Date(l.criado_em).toLocaleString('pt-BR')]
      .map(csvEscape)
      .join(';')
  );
  const csv = '﻿' + [cabecalho.map(csvEscape).join(';'), ...linhas].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-revenup-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.get('/admin/leads/:id', exigirLogin, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Lead não encontrado.');
  res.type('html').send(paginaLeadDetalhe(rows[0], req.session.csrfToken));
});

app.post('/admin/leads/:id/status', exigirLogin, verificarCsrf, async (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).send('Status inválido.');
  await pool.query(`UPDATE leads SET status = $1, atualizado_em = now() WHERE id = $2`, [status, req.params.id]);
  res.redirect(`/admin/leads/${req.params.id}`);
});

app.post('/admin/leads/:id/notas', exigirLogin, verificarCsrf, async (req, res) => {
  const notas = String((req.body && req.body.notas) || '').slice(0, 4000);
  await pool.query(`UPDATE leads SET notas = $1, atualizado_em = now() WHERE id = $2`, [notas, req.params.id]);
  res.redirect(`/admin/leads/${req.params.id}`);
});

// ---------- Templates HTML do painel (identidade visual RevenUp) ----------
const ESTILO_BASE = `
  body { font-family: 'Inter', Arial, sans-serif; background: #F5F5F5; margin: 0; color: #1A1A1A; }
  a { color: inherit; }
  header.topo { background: #102C54; color: #FFFFFF; padding: 20px 32px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
  header.topo h1 { font-family: 'Montserrat', Arial, sans-serif; font-size: 1.1rem; margin: 0; }
  header.topo nav { display: flex; gap: 16px; align-items: center; font-size: 0.9rem; }
  header.topo nav a { text-decoration: none; opacity: 0.85; }
  header.topo nav a:hover { opacity: 1; color: #FF8A33; }
  header.topo form button { background: transparent; border: 1px solid rgba(255,255,255,0.4); color: #FFFFFF; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-family: 'Inter', Arial, sans-serif; }
  header.topo form button:hover { border-color: #F15A24; color: #F15A24; }
  main { padding: 32px; max-width: 1100px; margin: 0 auto; }
  .btn { display: inline-block; background: #F15A24; color: #FFFFFF; font-family: 'Montserrat', Arial, sans-serif; font-weight: 600; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem; text-decoration: none; }
  .btn:hover { background: #FF8A33; }
  .btn-secundario { background: #FFFFFF; color: #102C54; border: 1px solid #D8D8D8; }
  .btn-secundario:hover { background: #F5F5F5; color: #102C54; }
`;

function paginaLogin(erro) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Painel RevenUp — Login</title>
<style>
  body { font-family: 'Inter', Arial, sans-serif; background: #F5F5F5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { background: #FFFFFF; border: 1px solid #E8E8E8; border-radius: 8px; padding: 40px; width: 100%; max-width: 360px; }
  h1 { font-family: 'Montserrat', Arial, sans-serif; color: #102C54; font-size: 1.3rem; margin: 0 0 24px; }
  label { font-family: 'Montserrat', Arial, sans-serif; font-weight: 600; font-size: 0.85rem; color: #102C54; display: block; margin-bottom: 6px; }
  input { width: 100%; padding: 12px 14px; border: 1px solid #D8D8D8; border-radius: 4px; box-sizing: border-box; margin-bottom: 16px; font-size: 0.95rem; }
  button { width: 100%; background: #F15A24; color: #FFFFFF; font-family: 'Montserrat', Arial, sans-serif; font-weight: 600; padding: 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 0.95rem; }
  button:hover { background: #FF8A33; }
  .erro { color: #F15A24; font-size: 0.85rem; margin: -8px 0 16px; }
</style>
</head>
<body>
  <div class="box">
    <h1>Painel de Leads — RevenUp</h1>
    <form method="POST" action="/admin/login">
      <label for="senha">Senha</label>
      <input type="password" id="senha" name="senha" required autofocus />
      ${erro ? `<p class="erro">${escapeHtml(erro)}</p>` : ''}
      <button type="submit">Entrar</button>
    </form>
  </div>
</body>
</html>`;
}

function paginaLeads({ leads, total, pagina, totalPaginas, busca, statusFiltro, contagens, csrfToken }) {
  const filtrosStatus = STATUSES.map(
    (s) =>
      `<a href="?status=${s}${busca ? `&q=${encodeURIComponent(busca)}` : ''}" class="chip${statusFiltro === s ? ' ativo' : ''}">${STATUS_LABEL[s]} (${contagens[s] || 0})</a>`
  ).join('');

  const linhas = leads
    .map(
      (lead) => `
        <tr data-href="/admin/leads/${lead.id}">
          <td>${escapeHtml(lead.nome)}</td>
          <td>${escapeHtml(lead.email)}</td>
          <td>${escapeHtml(lead.empresa || '-')}</td>
          <td><span class="status status-${lead.status}">${STATUS_LABEL[lead.status] || lead.status}</span></td>
          <td>${new Date(lead.criado_em).toLocaleString('pt-BR')}</td>
        </tr>`
    )
    .join('');

  const paginacao =
    totalPaginas > 1
      ? `<div class="paginacao">
          ${pagina > 1 ? `<a href="?pagina=${pagina - 1}${statusFiltro ? `&status=${statusFiltro}` : ''}${busca ? `&q=${encodeURIComponent(busca)}` : ''}">← Anterior</a>` : '<span></span>'}
          <span>Página ${pagina} de ${totalPaginas}</span>
          ${pagina < totalPaginas ? `<a href="?pagina=${pagina + 1}${statusFiltro ? `&status=${statusFiltro}` : ''}${busca ? `&q=${encodeURIComponent(busca)}` : ''}">Próxima →</a>` : '<span></span>'}
        </div>`
      : '';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Painel RevenUp — Leads</title>
<style>
  ${ESTILO_BASE}
  .barra { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; margin-bottom: 20px; }
  .busca { display: flex; gap: 8px; }
  .busca input { padding: 10px 14px; border: 1px solid #D8D8D8; border-radius: 4px; font-size: 0.9rem; min-width: 220px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
  .chip { text-decoration: none; font-size: 0.82rem; padding: 6px 12px; border-radius: 999px; background: #FFFFFF; border: 1px solid #D8D8D8; color: #555; }
  .chip.ativo { background: #102C54; border-color: #102C54; color: #FFFFFF; }
  table { width: 100%; border-collapse: collapse; background: #FFFFFF; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 14px 16px; border-bottom: 1px solid #E8E8E8; font-size: 0.9rem; vertical-align: top; }
  th { font-family: 'Montserrat', Arial, sans-serif; color: #102C54; background: #F5F5F5; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: none; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: #FFF7F2; }
  .status { font-size: 0.78rem; padding: 4px 10px; border-radius: 999px; font-weight: 600; }
  .status-novo { background: #FFF1E8; color: #F15A24; }
  .status-em_contato { background: #FFF7E0; color: #B37E00; }
  .status-qualificado { background: #E8F0FF; color: #102C54; }
  .status-cliente { background: #E6F6EC; color: #1A7A3C; }
  .status-descartado { background: #F0F0F0; color: #888; }
  .vazio { padding: 48px; text-align: center; color: #888; background: #FFFFFF; border-radius: 8px; }
  .paginacao { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; font-size: 0.9rem; color: #555; }
  .paginacao a { color: #102C54; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
  <header class="topo">
    <h1>Painel de Leads — RevenUp (${total})</h1>
    <nav>
      <a href="/admin/leads/export.csv">Exportar CSV</a>
      <form method="POST" action="/admin/logout"><input type="hidden" name="_csrf" value="${csrfToken}" /><button type="submit">Sair</button></form>
    </nav>
  </header>
  <main>
    <div class="barra">
      <form class="busca" method="GET" action="/admin/leads">
        <input type="text" name="q" placeholder="Buscar por nome, e-mail ou empresa" value="${escapeHtml(busca)}" />
        ${statusFiltro ? `<input type="hidden" name="status" value="${statusFiltro}" />` : ''}
        <button type="submit" class="btn btn-secundario">Buscar</button>
      </form>
    </div>
    <div class="chips">
      <a href="/admin/leads${busca ? `?q=${encodeURIComponent(busca)}` : ''}" class="chip${!statusFiltro ? ' ativo' : ''}">Todos (${total})</a>
      ${filtrosStatus}
    </div>
    ${
      leads.length === 0
        ? '<div class="vazio">Nenhum lead encontrado.</div>'
        : `<table>
      <thead><tr><th>Nome</th><th>E-mail</th><th>Empresa</th><th>Status</th><th>Recebido em</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>`
    }
    ${paginacao}
  </main>
  <script src="/admin-leads.js"></script>
</body>
</html>`;
}

function paginaLeadDetalhe(lead, csrfToken) {
  const opcoesStatus = STATUSES.map(
    (s) => `<option value="${s}" ${lead.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`
  ).join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Lead — ${escapeHtml(lead.nome)}</title>
<style>
  ${ESTILO_BASE}
  .voltar { display: inline-block; margin-bottom: 16px; color: #102C54; text-decoration: none; font-size: 0.9rem; }
  .cartao { background: #FFFFFF; border-radius: 8px; padding: 28px; margin-bottom: 20px; }
  .cartao h2 { font-family: 'Montserrat', Arial, sans-serif; color: #102C54; margin: 0 0 4px; }
  .cartao .empresa { color: #888; font-size: 0.9rem; margin-bottom: 20px; }
  .campo { margin-bottom: 16px; }
  .campo label { display: block; font-family: 'Montserrat', Arial, sans-serif; font-weight: 600; font-size: 0.8rem; color: #102C54; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 4px; }
  .campo p { margin: 0; font-size: 0.95rem; white-space: pre-wrap; }
  select, textarea { width: 100%; padding: 10px 12px; border: 1px solid #D8D8D8; border-radius: 4px; font-family: 'Inter', Arial, sans-serif; font-size: 0.9rem; box-sizing: border-box; }
  textarea { min-height: 100px; resize: vertical; }
  .form-inline { display: flex; gap: 12px; align-items: flex-end; }
  .form-inline select { flex: 1; }
</style>
</head>
<body>
  <header class="topo">
    <h1>Lead — RevenUp</h1>
    <nav><a href="/admin/leads">← Voltar ao painel</a></nav>
  </header>
  <main>
    <div class="cartao">
      <h2>${escapeHtml(lead.nome)}</h2>
      <div class="empresa">${escapeHtml(lead.empresa || 'Empresa não informada')} · recebido em ${new Date(lead.criado_em).toLocaleString('pt-BR')}</div>

      <div class="campo">
        <label>E-mail</label>
        <p><a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a></p>
      </div>
      <div class="campo">
        <label>Mensagem</label>
        <p>${escapeHtml(lead.mensagem)}</p>
      </div>
      <div class="campo">
        <label>Status</label>
        <form class="form-inline" method="POST" action="/admin/leads/${lead.id}/status">
          <input type="hidden" name="_csrf" value="${csrfToken}" />
          <select name="status">${opcoesStatus}</select>
          <button type="submit" class="btn">Salvar status</button>
        </form>
      </div>
      <div class="campo">
        <label>Notas internas</label>
        <form method="POST" action="/admin/leads/${lead.id}/notas">
          <input type="hidden" name="_csrf" value="${csrfToken}" />
          <textarea name="notas" placeholder="Anotações sobre esse contato...">${escapeHtml(lead.notas || '')}</textarea>
          <br /><br />
          <button type="submit" class="btn btn-secundario">Salvar notas</button>
        </form>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function csvEscape(valor) {
  const texto = String(valor ?? '').replace(/"/g, '""');
  return `"${texto}"`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Inicialização ----------
init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`RevenUp site rodando em http://localhost:${PORT}`);
    });
  })
  .catch((erro) => {
    console.error('Falha ao inicializar o banco de dados:', erro);
    process.exit(1);
  });
