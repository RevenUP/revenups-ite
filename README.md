# Site RevenUp — com backend

Site institucional da RevenUp com formulário de contato funcional e
painel de leads protegido por senha.

## O que tem aqui

- `public/index.html` — o site (front-end), identidade visual oficial da RevenUp.
- `server.js` — backend Express: recebe o formulário, salva os leads e serve o painel `/admin`.
- `data/db.json` — banco de dados local dos leads (criado automaticamente, não vai para o Git).

## Rodar localmente

```
npm install
copy .env.example .env    (no Windows; no Mac/Linux: cp .env.example .env)
```

Edite o `.env` e defina pelo menos `ADMIN_PASSWORD` e `SESSION_SECRET`
(qualquer texto). Os campos de `SMTP_*` são opcionais — sem eles o site
funciona normalmente, só não manda e-mail de notificação a cada lead
(os leads continuam salvos e visíveis em `/admin`).

```
npm start
```

Abra `http://localhost:3000` para o site, e `http://localhost:3000/admin`
para o painel de leads (login com a senha definida em `ADMIN_PASSWORD`).

## Publicar (deploy)

Este backend precisa de um servidor Node rodando de verdade — não dá
para publicar em GitHub Pages (só arquivos estáticos). O caminho mais
simples e gratuito para começar:

### 1. Subir o código no GitHub
Já deve estar feito se você chegou até este README pelo repositório.

### 2. Conectar num serviço que roda Node (Render, gratuito)
1. Criar conta em [render.com](https://render.com) (pode entrar com GitHub).
2. "New +" → "Web Service" → escolher este repositório.
3. Configurações:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Em "Environment", adicionar as variáveis do `.env.example`
   (`ADMIN_PASSWORD`, `SESSION_SECRET`, e opcionalmente `SMTP_*`) com
   valores reais — nunca commitar esses valores no código.
5. Deploy. O Render dá uma URL pública (ex.: `revenup.onrender.com`).

### 3. Domínio próprio (opcional)
Depois de publicado, qualquer domínio comprado (Registro.br, GoDaddy
etc.) pode ser apontado para a URL do Render nas configurações do
próprio Render ("Custom Domains").

## Segurança

- Senha do painel nunca fica no código — só em variável de ambiente (`ADMIN_PASSWORD`).
- Sessão de login expira em 8 horas.
- Limite simples de tentativas por IP no formulário (proteção básica contra spam).
- `.env` e `data/db.json` nunca são commitados (ver `.gitignore`).
