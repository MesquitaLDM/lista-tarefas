const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-em-producao';

// ── DB (Postgres) ────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listas (
      id TEXT PRIMARY KEY,
      nome TEXT,
      criado_em TIMESTAMPTZ DEFAULT now(),
      publicado BOOLEAN DEFAULT false
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS itens (
      id TEXT PRIMARY KEY,
      lista_id TEXT REFERENCES listas(id) ON DELETE CASCADE,
      sku TEXT,
      descricao TEXT,
      ean TEXT,
      qtd TEXT,
      local_origem TEXT,
      local_destino TEXT,
      curva TEXT,
      log TEXT,
      responsavel TEXT,
      usuario TEXT,
      feito BOOLEAN DEFAULT false,
      feito_em TIMESTAMPTZ,
      tarefa_gerada BOOLEAN DEFAULT false,
      tarefa_em TIMESTAMPTZ
    );
  `);
  // Migração: garante colunas em bancos já existentes
  await pool.query(`ALTER TABLE itens ADD COLUMN IF NOT EXISTS usuario TEXT;`);
  await pool.query(`ALTER TABLE itens ADD COLUMN IF NOT EXISTS tarefa_gerada BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE itens ADD COLUMN IF NOT EXISTS tarefa_em TIMESTAMPTZ;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      senha_hash TEXT,
      papel TEXT NOT NULL DEFAULT 'operador',
      criado_em TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS locais_altos (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      descricao TEXT,
      local TEXT,
      quantidade INTEGER DEFAULT 0,
      atualizado_em TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_locais_altos_sku ON locais_altos(sku);`);

  // Cria um usuário admin padrão se não existir nenhum ADM
  const { rows } = await pool.query(`SELECT COUNT(*) FROM usuarios WHERE papel='adm'`);
  if (parseInt(rows[0].count) === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      `INSERT INTO usuarios (id, username, senha_hash, papel) VALUES ($1,$2,$3,'adm')`,
      [uuidv4(), 'admin', hash]
    );
    console.log('Usuário ADM padrão criado: admin / admin123 (troque a senha depois!)');
  }

  console.log('Banco de dados pronto');
}

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({ storage: multer.memoryStorage() });

// ── AUTH HELPERS ─────────────────────────────────────────

function gerarToken(usuario) {
  return jwt.sign({ id: usuario.id, username: usuario.username, papel: usuario.papel }, JWT_SECRET, { expiresIn: '12h' });
}

function autenticarAdm(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ erro: 'Não autenticado' });
  try {
    const dados = jwt.verify(token, JWT_SECRET);
    if (dados.papel !== 'adm') return res.status(403).json({ erro: 'Acesso restrito ao ADM' });
    req.usuario = dados;
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Sessão inválida' });
  }
}

// ── AUTH ROTAS ───────────────────────────────────────────

// Login ADM (usuário + senha)
app.post('/api/login', async (req, res) => {
  try {
    const { username, senha } = req.body;
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE username=$1 AND papel=$2', [username, 'adm']);
    if (!rows.length) return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
    const usuario = rows[0];
    const ok = await bcrypt.compare(senha || '', usuario.senha_hash || '');
    if (!ok) return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
    const token = gerarToken(usuario);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 12*60*60*1000 });
    res.json({ ok: true, username: usuario.username, papel: usuario.papel });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ logado: false });
  try {
    const dados = jwt.verify(token, JWT_SECRET);
    res.json({ logado: true, username: dados.username, papel: dados.papel });
  } catch (e) {
    res.json({ logado: false });
  }
});

// Login do coletor — apenas valida que o usuário existe (sem senha)
app.post('/api/coletor/login', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ erro: 'Informe o usuário' });
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE username=$1', [username.trim()]);
    if (!rows.length) return res.status(401).json({ erro: 'Usuário não encontrado' });
    res.json({ ok: true, username: rows[0].username, papel: rows[0].papel });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── USUÁRIOS (ADM) ───────────────────────────────────────

app.get('/api/usuarios', autenticarAdm, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, papel, criado_em FROM usuarios ORDER BY criado_em DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/usuarios', autenticarAdm, async (req, res) => {
  try {
    const { username, senha, papel } = req.body;
    if (!username || !papel) return res.status(400).json({ erro: 'Usuário e papel são obrigatórios' });
    if (papel === 'adm' && !senha) return res.status(400).json({ erro: 'Senha é obrigatória para usuários ADM' });
    const id = uuidv4();
    const hash = senha ? await bcrypt.hash(senha, 10) : null;
    await pool.query('INSERT INTO usuarios (id, username, senha_hash, papel) VALUES ($1,$2,$3,$4)', [id, username.trim(), hash, papel]);
    res.json({ id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ erro: 'Esse usuário já existe' });
    res.status(500).json({ erro: e.message });
  }
});

app.patch('/api/usuarios/:id', autenticarAdm, async (req, res) => {
  try {
    const { senha, papel } = req.body;
    if (senha) {
      const hash = await bcrypt.hash(senha, 10);
      await pool.query('UPDATE usuarios SET senha_hash=$1 WHERE id=$2', [hash, req.params.id]);
    }
    if (papel) {
      await pool.query('UPDATE usuarios SET papel=$1 WHERE id=$2', [papel, req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/usuarios/:id', autenticarAdm, async (req, res) => {
  try {
    await pool.query('DELETE FROM usuarios WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── LISTAS (protegido ADM) ───────────────────────────────

app.get('/api/listas', autenticarAdm, async (req, res) => {
  try {
    const { rows: listas } = await pool.query('SELECT * FROM listas ORDER BY criado_em DESC');
    for (const l of listas) {
      const total = await pool.query('SELECT COUNT(*) FROM itens WHERE lista_id=$1', [l.id]);
      const feitos = await pool.query('SELECT COUNT(*) FROM itens WHERE lista_id=$1 AND feito=true', [l.id]);
      l.total = parseInt(total.rows[0].count);
      l.feitos = parseInt(feitos.rows[0].count);
    }
    res.json(listas);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/listas', autenticarAdm, async (req, res) => {
  try {
    const { nome } = req.body;
    const id = uuidv4();
    await pool.query('INSERT INTO listas (id, nome) VALUES ($1,$2)', [id, nome || 'Nova lista']);
    res.json({ id });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/listas/:id', autenticarAdm, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM listas WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Lista não encontrada' });
    const lista = rows[0];
    const itens = await pool.query('SELECT * FROM itens WHERE lista_id=$1 ORDER BY local_origem, sku', [req.params.id]);
    lista.itens = itens.rows;
    res.json(lista);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/listas/:id/publicar', autenticarAdm, async (req, res) => {
  try {
    const { publicado } = req.body;
    await pool.query('UPDATE listas SET publicado=$1 WHERE id=$2', [!!publicado, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/listas/:id', autenticarAdm, async (req, res) => {
  try {
    const { nome } = req.body;
    await pool.query('UPDATE listas SET nome=$1 WHERE id=$2', [nome, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/listas/:id', autenticarAdm, async (req, res) => {
  try {
    await pool.query('DELETE FROM itens WHERE lista_id=$1', [req.params.id]);
    await pool.query('DELETE FROM listas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── ITENS (protegido ADM para criar/excluir) ─────────────

app.post('/api/listas/:id/itens', autenticarAdm, async (req, res) => {
  try {
    const item = req.body;
    const id = uuidv4();
    await pool.query(
      `INSERT INTO itens (id,lista_id,sku,descricao,ean,qtd,local_origem,local_destino,curva,log,responsavel,usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, req.params.id, item.sku||'', item.descricao||'', item.ean||'', item.qtd||'1',
       item.local_origem||'', item.local_destino||'', item.curva||'', item.log||'', item.responsavel||'', item.usuario||'']
    );
    res.json({ id });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/itens/:id', autenticarAdm, async (req, res) => {
  try {
    await pool.query('DELETE FROM itens WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Marcar/desmarcar feito (coletor - sem auth ADM, qualquer operador pode)
app.patch('/api/itens/:id/feito', async (req, res) => {
  try {
    const { feito } = req.body;
    await pool.query('UPDATE itens SET feito=$1, feito_em=$2 WHERE id=$3', [!!feito, feito ? new Date() : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Marcar/desmarcar tarefa gerada (coletor)
app.patch('/api/itens/:id/tarefa', async (req, res) => {
  try {
    const { tarefa_gerada } = req.body;
    await pool.query('UPDATE itens SET tarefa_gerada=$1, tarefa_em=$2 WHERE id=$3', [!!tarefa_gerada, tarefa_gerada ? new Date() : null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── COLETOR: itens do usuário logado (lista publicada) ───

app.get('/api/coletor/itens', async (req, res) => {
  try {
    const { usuario } = req.query;
    if (!usuario) return res.status(400).json({ erro: 'Informe o usuário' });

    const { rows: listas } = await pool.query('SELECT * FROM listas WHERE publicado=true ORDER BY criado_em DESC');
    const resultado = [];
    for (const l of listas) {
      const { rows: itens } = await pool.query(
        'SELECT * FROM itens WHERE lista_id=$1 AND usuario=$2 ORDER BY local_origem, sku',
        [l.id, usuario]
      );
      if (itens.length) resultado.push({ id: l.id, nome: l.nome, itens });
    }
    res.json(resultado);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── IMPORTAR XLSX ────────────────────────────────────────

app.post('/api/listas/:id/importar', autenticarAdm, upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const map = {
      sku: ['Item','item','SKU','Código','Codigo'],
      descricao: ['Descrição item','Descricao item','Descrição','Descricao','desc'],
      ean: ['Ean','EAN','ean'],
      qtd: ['Qtd. Pedida','Qtd Pedida','Qtd','qtd','Quantidade'],
      local_origem: ['Local','local','Localização','Local origem'],
      curva: ['Curva','curva'],
      local_destino: ['Local picking','Picking','picking','Local destino'],
      log: ['LOG','Log','log'],
      responsavel: ['Nome','nome','Responsavel','Responsável'],
      usuario: ['Usuário','Usuario','usuario','Login','login','User']
    };

    function getVal(row, keys) {
      for (const k of keys) if (row[k] !== undefined && row[k] !== '') return String(row[k]).trim();
      return '';
    }

    const valid = data.filter(r => getVal(r,map.sku) || getVal(r,map.descricao));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of valid) {
        await client.query(
          `INSERT INTO itens (id,lista_id,sku,descricao,ean,qtd,local_origem,local_destino,curva,log,responsavel,usuario)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [uuidv4(), req.params.id, getVal(r,map.sku), getVal(r,map.descricao), getVal(r,map.ean),
           getVal(r,map.qtd)||'1', getVal(r,map.local_origem), getVal(r,map.local_destino),
           getVal(r,map.curva), getVal(r,map.log), getVal(r,map.responsavel), getVal(r,map.usuario)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ importados: valid.length });
  } catch(e) {
    res.status(500).json({ erro: 'Erro ao processar planilha: ' + e.message });
  }
});

// ── LOCAIS ALTOS ─────────────────────────────────────────

// Consultar locais alternativos por SKU (coletor)
app.get('/api/locais-altos/:sku', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT local, descricao, quantidade FROM locais_altos WHERE sku=$1 ORDER BY quantidade DESC',
      [req.params.sku]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Importar QRY de locais altos (ADM)
app.post('/api/locais-altos/importar', autenticarAdm, upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

    function getVal(row, keys) {
      for (const k of keys) if (row[k] !== undefined && row[k] !== '') return String(row[k]).trim();
      return '';
    }

    const mapSku = ['Item','item','SKU','Código','Codigo'];
    const mapDesc = ['Descrição','Descricao','Descrição item','desc'];
    const mapLocal = ['Descrição_2','Descricao_2','Local picking','Local','local'];
    const mapQtd = ['Quantidade','quantidade','Qtd','qtd'];

    const valid = data.filter(r => getVal(r, mapSku) && getVal(r, mapLocal));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Limpa tabela antes de reimportar
      await client.query('DELETE FROM locais_altos');
      for (const r of valid) {
        await client.query(
          `INSERT INTO locais_altos (id, sku, descricao, local, quantidade) VALUES ($1,$2,$3,$4,$5)`,
          [uuidv4(), getVal(r, mapSku), getVal(r, mapDesc), getVal(r, mapLocal), parseInt(getVal(r, mapQtd)) || 0]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ importados: valid.length });
  } catch(e) {
    res.status(500).json({ erro: 'Erro ao processar QRY: ' + e.message });
  }
});

// Total de locais altos cadastrados
app.get('/api/locais-altos', autenticarAdm, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) as total, MAX(atualizado_em) as atualizado FROM locais_altos');
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Rotas SPA
app.get('/adm', (req, res) => res.sendFile(path.join(__dirname, '../public/adm/index.html')));
app.get('/adm/*', (req, res) => res.sendFile(path.join(__dirname, '../public/adm/index.html')));
app.get('/coletor', (req, res) => res.sendFile(path.join(__dirname, '../public/coletor/index.html')));
app.get('/coletor/*', (req, res) => res.sendFile(path.join(__dirname, '../public/coletor/index.html')));
app.get('/curva-abc', (req, res) => res.sendFile(path.join(__dirname, '../public/curva-abc/index.html')));
app.get('/curva-abc/*', (req, res) => res.sendFile(path.join(__dirname, '../public/curva-abc/index.html')));

initDb().then(() => {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}).catch(err => {
  console.error('Erro ao iniciar banco de dados:', err);
  process.exit(1);
});
