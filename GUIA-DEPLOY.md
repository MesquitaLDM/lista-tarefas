# 🚀 Guia de Deploy — Lista de Tarefas (100% Gratuito)

## O que você vai ter no final
- **`seu-app.onrender.com/adm`** → Painel do ADM (importar Excel, criar listas, publicar)
- **`seu-app.onrender.com/coletor`** → Tela do colaborador no coletor de dados
- **`seu-app.onrender.com`** → Página de seleção (ADM ou Coletor)

Este guia usa o **Blueprint do Render**, que cria automaticamente o servidor web **e** o banco de dados (Postgres gratuito) de uma vez só.

---

## PASSO 1 — Criar conta no GitHub
1. Acesse **github.com** e clique em **Sign up**
2. Preencha e-mail, senha e nome de usuário
3. Confirme o e-mail que chegar na sua caixa

---

## PASSO 2 — Criar repositório no GitHub
1. Após entrar no GitHub, clique no botão verde **"New"** (canto superior esquerdo)
2. Em **Repository name**, escreva: `lista-tarefas`
3. Deixe marcado como **Public**
4. Clique em **"Create repository"**

---

## PASSO 3 — Subir os arquivos
1. Na página do repositório criado, clique em **"uploading an existing file"**
2. Abra a pasta `lista-tarefas` que você baixou (descompacte o ZIP primeiro)
3. **Selecione todos os arquivos e pastas** e arraste para a área indicada no GitHub

   > ⚠️ Certifique-se de incluir:
   > - pasta `server/`
   > - pasta `public/`
   > - `package.json`
   > - `render.yaml`
   > - `.gitignore`

4. Role para baixo e clique em **"Commit changes"**

---

## PASSO 4 — Criar conta no Render
1. Acesse **render.com** e clique em **Get Started for Free**
2. Clique em **"Continue with GitHub"** e autorize o acesso

---

## PASSO 5 — Deploy via Blueprint (cria tudo automaticamente)
1. No painel do Render, clique em **"New +"** → **"Blueprint"**
2. Selecione o repositório **lista-tarefas**
3. O Render vai detectar o arquivo `render.yaml` e mostrar:
   - Um **Web Service** (`lista-tarefas-armazem`)
   - Um **Banco de dados Postgres** (`lista-tarefas-db`)
4. Clique em **"Apply"**
5. Aguarde o deploy terminar (3–5 minutos)

> O Render já conecta o banco de dados automaticamente ao servidor — você não precisa configurar nada manualmente.

---

## PASSO 6 — Acessar o sistema ✅
1. Quando o status ficar verde ("Live"), clique na URL gerada
   (ex: `https://lista-tarefas-armazem-xxxx.onrender.com`)

### URLs de acesso:
| Quem | URL |
|------|-----|
| ADM | `https://seu-app.onrender.com/adm` |
| Coletor | `https://seu-app.onrender.com/coletor` |

---

## ⚠️ Observações importantes

**Plano gratuito do Render:**
- O servidor web "dorme" após 15 minutos sem uso — a primeira abertura do dia pode demorar ~30-50 segundos para acordar
- O banco Postgres gratuito expira após 90 dias (o Render avisa por e-mail antes; basta criar um novo se necessário, ou migrar para o plano pago do banco)
- Para evitar o "sono" do servidor, considere o plano Starter ($7/mês)

**Atualizações futuras:**
- Sempre que precisar atualizar o sistema, basta subir os arquivos novamente no GitHub (substituindo os antigos)
- O Render faz o re-deploy automaticamente

---

## 🔐 Login e usuários (novidade)

**Acesso ao ADM (`/adm`):**
- Usuário e senha padrão criados automaticamente na primeira vez: `admin` / `admin123`
- **Troque essa senha assim que possível** na aba **"Usuários"** dentro do painel ADM (clique no ícone de chave 🔑 ao lado do usuário `admin`)

**Cadastro de operadores:**
- Na aba **"Usuários"** do ADM, clique em **"Novo usuário"**
- Para operadores: informe o mesmo **usuário do bseller** (sem necessidade de senha)
- Para outro ADM: informe usuário **e** senha

**Acesso ao Coletor (`/coletor`):**
- O operador digita apenas o seu usuário (o mesmo do bseller) — sem senha
- O sistema mostra somente os itens vinculados a esse usuário

**Importação de planilha:**
- Inclua uma coluna chamada **"Usuário"** com o login do operador responsável por cada item
- Itens sem usuário vinculado não aparecerão para nenhum operador no coletor

---

## Dúvidas?
Se travar em algum passo, anote o erro e compartilhe — ajudo a resolver!
