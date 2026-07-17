# Site RevenUp — com backend

Site institucional da RevenUp com formulário de contato, banco de dados
Postgres, painel de leads (mini-CRM) e sincronização automática com o
Cérebro (`projeto RevenUp AI 1.0`).

Fluxograma completo (visitante → banco → painel → sincronização) em
[`FLUXOGRAMA.md`](FLUXOGRAMA.md).

## Arquitetura

```
Visitante → formulário (public/) → POST /api/contato → Postgres (Render)
                                                            │
                                          GET /api/sync/leads (protegido)
                                                            │
                                                            ▼
                              01 - Raiz/Ferramentas/Sincronização de Leads/
                                    sync-leads.js (roda localmente)
                                                            │
                                                            ▼
                         Workspace Entrega/{Cliente}/000 - Cadastro Mestre.md
                                     (arquivo permanente, Fluxo C)
```

O Postgres do Render é o banco "vivo" que recebe cada envio do formulário
em tempo real. Como o plano gratuito de banco expira em 30 dias, o
`sync-leads.js` roda periodicamente e copia todo lead novo para dentro
da pasta `Workspace Entrega/`, que é o arquivo permanente de verdade —
mesmo que o banco no Render expire ou seja recriado, nenhum lead se
perde depois de sincronizado.

## O que tem aqui

- `public/index.html` + `public/contato.js` — o site (front-end).
- `server.js` — backend Express (rotas, sessão, segurança).
- `db.js` — conexão e schema do Postgres.
- `data/db.json` **não existe mais** — leads ficam no Postgres, não em arquivo local.

## Funcionalidades do backend

- Formulário de contato validado (zod) e limitado por IP (anti-spam).
- Painel `/admin` protegido por senha, com:
  - busca por nome/e-mail/empresa;
  - filtro por status (Novo, Em contato, Qualificado, Cliente, Descartado);
  - paginação;
  - página de detalhe por lead, com notas internas;
  - exportação CSV.
- Endpoint `/api/sync/leads` (protegido por `LEADS_SYNC_KEY`, separado da
  senha do painel) para o script de sincronização com o Cérebro.
- `/healthz` para checagem de disponibilidade.
- Segurança: Helmet (cabeçalhos HTTP), rate limiting, CSRF nas ações do
  painel, senha comparada com `crypto.timingSafeEqual` (nunca em texto
  plano no código), sessão expira em 8h.
- Log de acesso via `morgan` (aparece nos logs do Render).
- Notificação por e-mail a cada novo lead é opcional (`SMTP_*`).

## Rodar localmente

```
npm install
copy .env.example .env    (no Windows; no Mac/Linux: cp .env.example .env)
```

Edite o `.env`: `ADMIN_PASSWORD`, `SESSION_SECRET`, `LEADS_SYNC_KEY`
(qualquer texto) e `DATABASE_URL` apontando para um Postgres (local ou a
**External Database URL** do Render, disponível no painel do banco —
nunca a Internal URL fora da rede do Render).

```
npm start
```

`http://localhost:3000` para o site, `http://localhost:3000/admin` para
o painel.

## Publicar (deploy)

Já publicado em produção: **https://revenups-ite.onrender.com**, com o
banco `revenup-leads-db` (Postgres, plano Free, Oregon) vinculado via
variável `DATABASE_URL`. Qualquer push para `main` aciona redeploy
automático no Render.

Variáveis de ambiente configuradas no serviço (Render → Environment):
`ADMIN_PASSWORD`, `SESSION_SECRET`, `DATABASE_URL`, `LEADS_SYNC_KEY`,
`NODE_ENV`, `CONTATO_DESTINO`. `SMTP_*` fica de fora até decidir ativar
notificação por e-mail.

### Limitações do plano gratuito (Render)

- **Banco expira em 30 dias** (mais 14 de carência) se não for
  upgradado — por isso a sincronização com `Workspace Entrega/` existe:
  ela é o arquivo permanente, o Postgres é só o buffer em tempo real.
- Disco do serviço web é efêmero (por isso os leads vão para o Postgres,
  não para um arquivo local).
- Serviço "dorme" após 15 min de inatividade (~50s para acordar).
- 5 GB de banda e 500 min de build incluídos por mês.

## Segurança

- Senha do painel e chave de sincronização nunca ficam no código — só em
  variável de ambiente.
- `.env` nunca é commitado (ver `.gitignore`).
- CSRF token por sessão em toda ação que altera dado (status, notas, logout).
- Rate limiting no formulário público e no login do painel.
