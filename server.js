require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const nodemailer = require('nodemailer');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const adapter = new FileSync(DB_PATH);
const db = low(adapter);
db.defaults({ leads: [] }).write();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8, // 8 horas
    },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Anti-spam simples: limite por IP ----------
const tentativasPorIp = new Map();
function limiteExcedido(ip) {
  const agora = Date.now();
  const janela = 10 * 60 * 1000; // 10 minutos
  const maxTentativas = 5;

  const registros = (tentativasPorIp.get(ip) || []).filter((t) => agora - t < janela);
  registros.push(agora);
  tentativasPorIp.set(ip, registros);

  return registros.length > maxTentativas;
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------- E-mail (opcional — só ativa se SMTP_* estiver configurado) ----------
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
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

// ---------- API: formulário de contato ----------
app.post('/api/contato', async (req, res) => {
  const ip = req.ip;
  if (limiteExcedido(ip)) {
    return res.status(429).json({ erro: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  }

  const { nome, email, empresa, mensagem } = req.body || {};

  if (!nome || !email || !mensagem) {
    return res.status(400).json({ erro: 'Nome, e-mail e mensagem são obrigatórios.' });
  }
  if (!emailValido(email)) {
    return res.status(400).json({ erro: 'E-mail inválido.' });
  }

  const lead = {
    id: crypto.randomUUID(),
    nome: String(nome).slice(0, 200),
    email: String(email).slice(0, 200),
    empresa: String(empresa || '').slice(0, 200),
    mensagem: String(mensagem).slice(0, 4000),
    criadoEm: new Date().toISOString(),
    origem: 'site',
  };

  db.get('leads').push(lead).write();
  notificarNovoLead(lead);

  res.status(201).json({ ok: true });
});

// ---------- Admin: autenticação ----------
function exigirLogin(req, res, next) {
  if (req.session && req.session.autenticado) return next();
  return res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  if (req.session && req.session.autenticado) return res.redirect('/admin/leads');
  res.type('html').send(paginaLogin());
});

app.post('/admin/login', (req, res) => {
  const { senha } = req.body || {};

  if (!ADMIN_PASSWORD) {
    return res.type('html').send(paginaLogin('Painel não configurado — defina ADMIN_PASSWORD no servidor.'));
  }

  const senhaBuffer = Buffer.from(String(senha || ''));
  const esperadaBuffer = Buffer.from(ADMIN_PASSWORD);
  const senhaCorreta =
    senhaBuffer.length === esperadaBuffer.length &&
    crypto.timingSafeEqual(senhaBuffer, esperadaBuffer);

  if (!senhaCorreta) {
    return res.type('html').send(paginaLogin('Senha incorreta.'));
  }

  req.session.autenticado = true;
  res.redirect('/admin/leads');
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

app.get('/admin/leads', exigirLogin, (req, res) => {
  const leads = db.get('leads').sortBy('criadoEm').reverse().value();
  res.type('html').send(paginaLeads(leads));
});

// ---------- Templates HTML do painel (mesma identidade visual do site) ----------
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
      ${erro ? `<p class="erro">${erro}</p>` : ''}
      <button type="submit">Entrar</button>
    </form>
  </div>
</body>
</html>`;
}

function paginaLeads(leads) {
  const linhas = leads
    .map(
      (lead) => `
        <tr>
          <td>${escapeHtml(lead.nome)}</td>
          <td><a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a></td>
          <td>${escapeHtml(lead.empresa || '-')}</td>
          <td>${escapeHtml(lead.mensagem)}</td>
          <td>${new Date(lead.criadoEm).toLocaleString('pt-BR')}</td>
        </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Painel RevenUp — Leads</title>
<style>
  body { font-family: 'Inter', Arial, sans-serif; background: #F5F5F5; margin: 0; color: #1A1A1A; }
  header { background: #102C54; color: #FFFFFF; padding: 20px 32px; display: flex; justify-content: space-between; align-items: center; }
  header h1 { font-family: 'Montserrat', Arial, sans-serif; font-size: 1.1rem; margin: 0; }
  header form button { background: transparent; border: 1px solid rgba(255,255,255,0.4); color: #FFFFFF; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-family: 'Inter', Arial, sans-serif; }
  header form button:hover { border-color: #F15A24; color: #F15A24; }
  main { padding: 32px; }
  table { width: 100%; border-collapse: collapse; background: #FFFFFF; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 14px 16px; border-bottom: 1px solid #E8E8E8; font-size: 0.9rem; vertical-align: top; }
  th { font-family: 'Montserrat', Arial, sans-serif; color: #102C54; background: #F5F5F5; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: none; }
  .vazio { padding: 48px; text-align: center; color: #888; }
</style>
</head>
<body>
  <header>
    <h1>Painel de Leads — RevenUp (${leads.length})</h1>
    <form method="POST" action="/admin/logout"><button type="submit">Sair</button></form>
  </header>
  <main>
    ${
      leads.length === 0
        ? '<div class="vazio">Nenhum lead recebido ainda.</div>'
        : `<table>
      <thead>
        <tr><th>Nome</th><th>E-mail</th><th>Empresa</th><th>Mensagem</th><th>Recebido em</th></tr>
      </thead>
      <tbody>${linhas}</tbody>
    </table>`
    }
  </main>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.listen(PORT, () => {
  console.log(`RevenUp site rodando em http://localhost:${PORT}`);
});
