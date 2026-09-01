const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
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
  await pool.query(`ALTER TABLE listas ADD COLUMN IF NOT EXISTS setor TEXT DEFAULT 'armazenagem';`);
  await pool.query(`ALTER TABLE itens ADD COLUMN IF NOT EXISTS tarefa_gerada BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE itens ADD COLUMN IF NOT EXISTS tarefa_em TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE listas ADD COLUMN IF NOT EXISTS prioridade TEXT DEFAULT 'normal';`);

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
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS acessos TEXT DEFAULT '[]';`);

  // Cria um usuário admin padrão se não existir nenhum ADM
  const { rows } = await pool.query(`SELECT COUNT(*) FROM usuarios WHERE papel IN ('adm','adm_central')`);
  if (parseInt(rows[0].count) === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      `INSERT INTO usuarios (id, username, senha_hash, papel) VALUES ($1,$2,$3,'adm_central')`,
      [uuidv4(), 'admin', hash]
    );
    console.log('Usuário ADM Central padrão criado: admin / admin123 (troque a senha depois!)');
  }

  console.log('Banco de dados pronto');
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

// ── AUTH HELPERS ─────────────────────────────────────────

function gerarToken(usuario) {
  return jwt.sign({ id: usuario.id, username: usuario.username, papel: usuario.papel, setor_adm: usuario.setor_adm||null }, JWT_SECRET, { expiresIn: '12h' });
}

function isAdm(papel) {
  return papel === 'adm_central' || papel === 'adm' || (papel && papel.startsWith('adm_'));
}
function setorDoAdm(papel) {
  if (papel === 'adm_central' || papel === 'adm') return null; // acesso total
  if (papel && papel.startsWith('adm_')) return papel.replace('adm_', '');
  return null;
}
function autenticarAdm(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ erro: 'Não autenticado' });
  try {
    const dados = jwt.verify(token, JWT_SECRET);
    if (!isAdm(dados.papel)) return res.status(403).json({ erro: 'Acesso restrito ao ADM' });
    req.usuario = dados;
    req.isCentral = (dados.papel === 'adm_central' || dados.papel === 'adm');
    req.setorAdm = setorDoAdm(dados.papel);
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
    const { rows } = await pool.query("SELECT * FROM usuarios WHERE username=$1 AND (papel='adm' OR papel='adm_central' OR papel LIKE 'adm_%')", [username]);
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
    res.json({ logado: true, username: dados.username, papel: dados.papel, setor_adm: setorDoAdm(dados.papel) });
  } catch (e) {
    res.json({ logado: false });
  }
});

// Login do coletor — apenas valida que o usuário existe (sem senha)
app.post('/api/coletor/login', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ erro: 'Informe o usuário' });
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE LOWER(username)=LOWER($1)', [username.trim()]);
    if (!rows.length) return res.status(401).json({ erro: 'Usuário não encontrado' });
    const u = rows[0];
    let acessos = [];
    try { acessos = JSON.parse(u.acessos || '[]'); } catch(e) {}
    res.json({ ok: true, username: u.username, papel: u.papel, acessos });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Verificar acesso do usuário a um setor específico
app.get('/api/coletor/acesso/:setor', async (req, res) => {
  try {
    const { usuario } = req.query;
    if (!usuario) return res.status(400).json({ erro: 'Informe o usuário' });
    const { rows } = await pool.query('SELECT acessos, papel FROM usuarios WHERE LOWER(username)=LOWER($1)', [usuario]);
    if (!rows.length) return res.json({ permitido: false });
    const u = rows[0];
    if (u.papel === 'adm' || u.papel === 'adm_central') return res.json({ permitido: true }); // ADM central acessa tudo
    if (u.papel && u.papel.startsWith('adm_')) return res.json({ permitido: u.papel === 'adm_'+req.params.setor });
    let acessos = [];
    try { acessos = JSON.parse(u.acessos || '[]'); } catch(e) {}
    res.json({ permitido: acessos.includes(req.params.setor) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── USUÁRIOS (ADM) ───────────────────────────────────────

app.get('/api/usuarios', autenticarAdm, async (req, res) => {
  try {
    let rows;
    if (req.isCentral) {
      ({ rows } = await pool.query('SELECT id, username, papel, acessos, criado_em FROM usuarios ORDER BY criado_em DESC'));
    } else {
      // ADM de setor vê só operadores do seu setor
      ({ rows } = await pool.query("SELECT id, username, papel, acessos, criado_em FROM usuarios WHERE papel='operador' ORDER BY criado_em DESC"));
      rows = rows.filter(u => { try { return JSON.parse(u.acessos||'[]').includes(req.setorAdm); } catch(e){ return false; } });
    }
    rows.forEach(u => { try { u.acessos = JSON.parse(u.acessos||'[]'); } catch(e) { u.acessos = []; } });
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/usuarios', autenticarAdm, async (req, res) => {
  try {
    const { username, senha, papel, acessos } = req.body;
    if (!username || !papel) return res.status(400).json({ erro: 'Usuário e papel são obrigatórios' });
    // ADM de setor só pode criar operadores
    if (!req.isCentral && papel !== 'operador') return res.status(403).json({ erro: 'Você só pode criar operadores' });
    // ADM de setor garante que o setor dele está nos acessos
    let acessosFinais = acessos || [];
    if (!req.isCentral && !acessosFinais.includes(req.setorAdm)) acessosFinais = [...acessosFinais, req.setorAdm];
    if (isAdm(papel) && !senha) return res.status(400).json({ erro: 'Senha é obrigatória para ADM' });
    const id = uuidv4();
    const hash = senha ? await bcrypt.hash(senha, 10) : null;
    await pool.query('INSERT INTO usuarios (id, username, senha_hash, papel, acessos) VALUES ($1,$2,$3,$4,$5)', [id, username.trim(), hash, papel, JSON.stringify(acessosFinais)]);
    res.json({ id });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ erro: 'Esse usuário já existe' });
    res.status(500).json({ erro: e.message });
  }
});

app.patch('/api/usuarios/:id', autenticarAdm, async (req, res) => {
  try {
    const { senha, papel, acessos } = req.body;
    if (!req.isCentral) {
      // ADM de setor: verificar se o usuário pertence ao seu setor
      const { rows } = await pool.query('SELECT acessos, papel FROM usuarios WHERE id=$1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado' });
      const alvo = rows[0];
      if (isAdm(alvo.papel)) return res.status(403).json({ erro: 'Sem permissão para editar ADMs' });
      let acessosAlvo = []; try { acessosAlvo = JSON.parse(alvo.acessos||'[]'); } catch(e){}
      if (!acessosAlvo.includes(req.setorAdm)) return res.status(403).json({ erro: 'Sem permissão para editar este usuário' });
    }
    if (senha) { const hash = await bcrypt.hash(senha, 10); await pool.query('UPDATE usuarios SET senha_hash=$1 WHERE id=$2', [hash, req.params.id]); }
    if (papel && req.isCentral) await pool.query('UPDATE usuarios SET papel=$1 WHERE id=$2', [papel, req.params.id]);
    if (acessos !== undefined) await pool.query('UPDATE usuarios SET acessos=$1 WHERE id=$2', [JSON.stringify(acessos), req.params.id]);
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
    let listas;
    if (req.isCentral) {
      ({ rows: listas } = await pool.query('SELECT * FROM listas ORDER BY criado_em DESC'));
    } else {
      ({ rows: listas } = await pool.query("SELECT * FROM listas WHERE setor=$1 ORDER BY criado_em DESC", [req.setorAdm]));
    }
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
    const { nome, prioridade } = req.body;
    const id = uuidv4();
    const setor = req.setorAdm || 'armazenagem';
    await pool.query(
      'INSERT INTO listas (id, nome, setor, prioridade) VALUES ($1,$2,$3,$4)',
      [id, nome || 'Nova lista', setor, prioridade || 'normal']
    );
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

app.patch('/api/listas/:id/prioridade', autenticarAdm, async (req, res) => {
  try {
    const { prioridade } = req.body;
    await pool.query('UPDATE listas SET prioridade=$1 WHERE id=$2', [prioridade, req.params.id]);
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

    const { rows: listas } = await pool.query(
      "SELECT * FROM listas WHERE publicado=true ORDER BY criado_em DESC"
    );

    let temAlta = false;
    for (const l of listas) {
      if ((l.prioridade || 'normal') === 'alta') {
        const { rows } = await pool.query(
          'SELECT COUNT(*) FROM itens WHERE lista_id=$1 AND LOWER(usuario)=LOWER($2) AND feito=false',
          [l.id, usuario]
        );
        if (parseInt(rows[0].count) > 0) { temAlta = true; break; }
      }
    }

    const resultado = [];
    for (const l of listas) {
      const prioridade = l.prioridade || 'normal';
      if (temAlta && prioridade !== 'alta') continue;
      if (!temAlta && prioridade === 'alta') continue;

      const { rows: itens } = await pool.query(
        'SELECT * FROM itens WHERE lista_id=$1 AND LOWER(usuario)=LOWER($2) ORDER BY local_origem, sku',
        [l.id, usuario]
      );
      if (itens.length) resultado.push({ id: l.id, nome: l.nome, prioridade, itens });
    }

    res.json({ listas: resultado, tem_alta: temAlta });
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

// ── TRANSITÓRIOS — LOCAIS VAZIOS ─────────────────────────────

pool.query(`
  CREATE TABLE IF NOT EXISTS transitorio_locais_vazios (
    id TEXT PRIMARY KEY,
    id_local TEXT,
    corredor TEXT,
    rua TEXT,
    coluna TEXT,
    nivel TEXT,
    descricao TEXT,
    grupo_classe TEXT,
    classe_local TEXT,
    importado_em TIMESTAMPTZ DEFAULT now()
  );
`).catch(console.error);

// Importar locais vazios (ADM)
app.post('/api/transitorio/importar-vazios', async (req, res) => {
  try {
    const { registros } = req.body;
    if (!Array.isArray(registros) || !registros.length)
      return res.status(400).json({ erro: 'Nenhum registro' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM transitorio_locais_vazios');
      await client.query('ALTER TABLE transitorio_locais_vazios ADD COLUMN IF NOT EXISTS id_local TEXT;');
      const LOTE = 200;
      for (let i = 0; i < registros.length; i += LOTE) {
        const lote = registros.slice(i, i + LOTE);
        const vals = lote.map((_, j) =>
          `($${j*9+1},$${j*9+2},$${j*9+3},$${j*9+4},$${j*9+5},$${j*9+6},$${j*9+7},$${j*9+8},$${j*9+9})`
        ).join(',');
        const params = lote.flatMap(r => [
          uuidv4(), r.id_local, r.corredor, r.rua, r.coluna, r.nivel,
          r.descricao, r.grupo_classe, r.classe_local
        ]);
        await client.query(
          `INSERT INTO transitorio_locais_vazios (id,id_local,corredor,rua,coluna,nivel,descricao,grupo_classe,classe_local) VALUES ${vals}`,
          params
        );
      }
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    res.json({ ok: true, importados: registros.length });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Buscar locais vazios próximos — aceita código bipado (005000 + id_local) ou endereço texto
app.get('/api/transitorio/vazios-proximos', async (req, res) => {
  try {
    const { endereco } = req.query;
    if (!endereco) return res.json([]);

    const { rows } = await pool.query('SELECT * FROM transitorio_locais_vazios ORDER BY descricao');
    if (!rows.length) return res.json([]);

    // Verificar se é um código bipado (começa com 005000)
    let refDescricao = endereco.trim();
    const PREFIXO = '005000';
    if (refDescricao.startsWith(PREFIXO)) {
      const idLocal = refDescricao.slice(PREFIXO.length).replace(/^0+/, '');
      const idLocalOriginal = refDescricao.slice(PREFIXO.length);
      console.log(`[VAZIOS] Buscando id_local="${idLocal}" em ${rows.length} locais vazios`);

      // Buscar primeiro nos locais vazios
      let localRef = rows.find(r =>
        String(r.id_local).trim() === idLocal ||
        String(r.id_local).trim() === idLocalOriginal
      );

      // Se não encontrou nos vazios, buscar nos locais de picking baixo
      if (!localRef) {
        const { rows: picking } = await pool.query(
          `SELECT id_local, local FROM transitorio_locais WHERE id_local=$1 OR id_local=$2 LIMIT 1`,
          [idLocal, idLocalOriginal]
        );
        if (picking.length) {
          refDescricao = picking[0].local;
          localRef = picking[0];
          console.log(`[VAZIOS] Encontrado nos locais de picking: "${refDescricao}"`);
        }
      } else {
        refDescricao = localRef.descricao;
        console.log(`[VAZIOS] Encontrado nos locais vazios: "${refDescricao}"`);
      }

      if (!localRef) {
        console.log(`[VAZIOS] ID ${idLocal} não encontrado em nenhuma tabela`);
        return res.json({ erro: 'Local não encontrado', id_local: idLocal });
      }
    }

    // Calcular proximidade baseado na Descrição
    const partes = refDescricao.trim().split(/\s+/);
    const [refCorredor, refRua, refColuna, refNivel] = partes;

    function calcProximidade(local) {
      const lp = (local.descricao||'').trim().split(/\s+/);
      const [lCorredor, lRua, lColuna, lNivel] = lp;
      let score = 0;
      if (lCorredor === refCorredor) score += 1000;
      score -= Math.abs(parseInt(lRua||0) - parseInt(refRua||0)) * 10;
      score -= Math.abs(parseInt(lColuna||0) - parseInt(refColuna||0)) * 2;
      score -= Math.abs(parseInt(lNivel||0) - parseInt(refNivel||0));
      return score;
    }

    const ordenados = rows
      .map(r => ({ ...r, score: calcProximidade(r) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    res.json({ vazios: ordenados, endereco_ref: refDescricao });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Total de locais vazios
app.get('/api/transitorio/vazios-total', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) as total FROM transitorio_locais_vazios');
    res.json(rows[0]);
  } catch(e) { res.json({ total: 0 }); }
});

// Criar tabela de locais baixos se não existir
pool.query(`
  CREATE TABLE IF NOT EXISTS transitorio_locais (
    id TEXT PRIMARY KEY,
    id_local TEXT,
    sku TEXT,
    descricao TEXT,
    ean TEXT,
    local TEXT,
    tipo_local TEXT,
    qtd INTEGER DEFAULT 0,
    disponivel INTEGER DEFAULT 0,
    importado_em TIMESTAMPTZ DEFAULT now()
  );
`).catch(console.error);
pool.query(`ALTER TABLE transitorio_locais ADD COLUMN IF NOT EXISTS id_local TEXT;`).catch(console.error);

// Importar planilha de locais baixos (qualquer usuário autenticado)
app.post('/api/transitorio/importar', async (req, res) => {
  try {
    const { registros } = req.body;
    if (!Array.isArray(registros) || !registros.length)
      return res.status(400).json({ erro: 'Nenhum registro enviado' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM transitorio_locais');
      const LOTE = 200;
      for (let i = 0; i < registros.length; i += LOTE) {
        const lote = registros.slice(i, i + LOTE);
        const vals = lote.map((_, j) =>
          `($${j*9+1},$${j*9+2},$${j*9+3},$${j*9+4},$${j*9+5},$${j*9+6},$${j*9+7},$${j*9+8},$${j*9+9})`
        ).join(',');
        const params = lote.flatMap(r => [
          uuidv4(), r.id_local, r.sku, r.descricao, r.ean, r.local, r.tipo_local,
          r.qtd || 0, r.disponivel || 0
        ]);
        await client.query(
          `INSERT INTO transitorio_locais (id,id_local,sku,descricao,ean,local,tipo_local,qtd,disponivel) VALUES ${vals}`,
          params
        );
      }
      await client.query('COMMIT');
    } catch(e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }

    res.json({ ok: true, importados: registros.length });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Buscar todos os locais (para o frontend carregar)
app.get('/api/transitorio/locais', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM transitorio_locais ORDER BY sku, local');
    res.json(rows);
  } catch(e) { res.json([]); }
});

// Buscar locais que têm um EAN, ordenados por proximidade ao local bipado
app.get('/api/transitorio/locais-proximos', async (req, res) => {
  try {
    const { ean, endereco } = req.query;
    if (!ean) return res.status(400).json({ erro: 'EAN não informado' });

    const { rows: itensDoEan } = await pool.query('SELECT * FROM transitorio_locais WHERE ean=$1', [ean]);
    if (!itensDoEan.length) return res.json({ locais: [], endereco_ref: endereco || null });

    if (!endereco) return res.json({ locais: itensDoEan, endereco_ref: null });

    // Resolver endereço de referência a partir do código bipado (005000 + id_local) ou texto direto
    let refDescricao = endereco.trim();
    let refItemId = null;
    const PREFIXO = '005000';
    if (refDescricao.startsWith(PREFIXO)) {
      const idLocal = refDescricao.slice(PREFIXO.length).replace(/^0+/, '');
      const idLocalOriginal = refDescricao.slice(PREFIXO.length);

      let localRef = itensDoEan.find(r =>
        String(r.id_local).trim() === idLocal || String(r.id_local).trim() === idLocalOriginal
      );

      if (localRef) {
        refDescricao = localRef.local;
        refItemId = localRef.id;
      } else {
        const { rows: picking } = await pool.query(
          'SELECT id, id_local, local FROM transitorio_locais WHERE id_local=$1 OR id_local=$2 LIMIT 1',
          [idLocal, idLocalOriginal]
        );
        if (picking.length) {
          refDescricao = picking[0].local;
          refItemId = picking[0].id;
        } else {
          const { rows: vazios } = await pool.query(
            'SELECT id_local, descricao FROM transitorio_locais_vazios WHERE id_local=$1 OR id_local=$2 LIMIT 1',
            [idLocal, idLocalOriginal]
          );
          if (vazios.length) {
            refDescricao = vazios[0].descricao;
          } else {
            return res.status(404).json({ erro: 'Local não encontrado', id_local: idLocal });
          }
        }
      }
    }

    // Remove o próprio local de referência da lista de sugestões (não faz sentido compactar nele mesmo)
    const normEndereco = s => (s || '').trim().replace(/\s+/g, ' ');
    const refNormalizado = normEndereco(refDescricao);
    const candidatos = itensDoEan.filter(r =>
      r.id !== refItemId && normEndereco(r.local) !== refNormalizado
    );

    const partes = refDescricao.trim().split(/\s+/);
    const [refCorredor, refRua, refColuna, refNivel] = partes;

    function calcProximidade(item) {
      const lp = (item.local || '').trim().split(/\s+/);
      const [lCorredor, lRua, lColuna, lNivel] = lp;
      let score = 0;
      if (lCorredor === refCorredor) score += 1000;
      score -= Math.abs(parseInt(lRua || 0) - parseInt(refRua || 0)) * 10;
      score -= Math.abs(parseInt(lColuna || 0) - parseInt(refColuna || 0)) * 2;
      score -= Math.abs(parseInt(lNivel || 0) - parseInt(refNivel || 0));
      return score;
    }

    const ordenados = candidatos
      .map(r => ({ ...r, score: calcProximidade(r) }))
      .sort((a, b) => b.score - a.score);

    res.json({ locais: ordenados, endereco_ref: refDescricao });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── MAPEAMENTO DE LOCAIS ─────────────────────────────────────

pool.query(`
  CREATE TABLE IF NOT EXISTS mapeamento_sessoes (
    id TEXT PRIMARY KEY,
    nome TEXT,
    prefixo_base TEXT,
    total_blocos INTEGER DEFAULT 0,
    status TEXT DEFAULT 'ativo',
    criado_em TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS mapeamento_blocos (
    id TEXT PRIMARY KEY,
    sessao_id TEXT,
    numero_bloco INTEGER,
    status TEXT DEFAULT 'pendente',
    criado_em TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE mapeamento_blocos ADD COLUMN IF NOT EXISTS prefixo TEXT;
  CREATE TABLE IF NOT EXISTS mapeamento_niveis (
    id TEXT PRIMARY KEY,
    bloco_id TEXT,
    sessao_id TEXT,
    nivel INTEGER,
    novo_nome TEXT,
    id_local_bipado TEXT,
    status TEXT DEFAULT 'pendente',
    criado_em TIMESTAMPTZ DEFAULT now()
  );
`).then(async () => {
  // Corrige blocos duplicados criados por uma falha antiga (condição de corrida
  // ao clicar duas vezes em "Salvar" na edição de quantidade de blocos).
  // Para cada duplicata, mantém o bloco com mais progresso e remove o(s) extra(s).
  try {
    const { rows: dups } = await pool.query(`
      SELECT sessao_id, numero_bloco FROM mapeamento_blocos
      GROUP BY sessao_id, numero_bloco HAVING COUNT(*) > 1
    `);
    for (const d of dups) {
      const { rows: candidatos } = await pool.query(`
        SELECT b.id, b.status,
          (SELECT COUNT(*) FROM mapeamento_niveis n WHERE n.bloco_id=b.id AND n.status='confirmado') AS niveis_confirmados
        FROM mapeamento_blocos b
        WHERE b.sessao_id=$1 AND b.numero_bloco=$2
        ORDER BY (b.status='confirmado') DESC, niveis_confirmados DESC, b.criado_em ASC
      `, [d.sessao_id, d.numero_bloco]);
      const remover = candidatos.slice(1).map(c => c.id);
      if (remover.length) {
        await pool.query('DELETE FROM mapeamento_niveis WHERE bloco_id = ANY($1)', [remover]);
        await pool.query('DELETE FROM mapeamento_blocos WHERE id = ANY($1)', [remover]);
      }
    }
    if (dups.length) console.log(`[MAPEAMENTO] ${dups.length} bloco(s) duplicado(s) corrigido(s) automaticamente.`);
  } catch(e) { console.error('[MAPEAMENTO] Erro ao corrigir blocos duplicados:', e.message); }

  // Preenche a coluna "prefixo" dos blocos antigos (criados antes desta versão),
  // derivando-a do nível 0 já existente, para manter compatibilidade.
  try {
    await pool.query(`
      UPDATE mapeamento_blocos b
      SET prefixo = regexp_replace(n.novo_nome, '\\s\\d{2}$', '')
      FROM mapeamento_niveis n
      WHERE n.bloco_id = b.id AND n.nivel = 0 AND b.prefixo IS NULL
    `);
  } catch(e) { console.error('[MAPEAMENTO] Erro ao preencher prefixo dos blocos:', e.message); }

  // Trava de segurança no banco: impede que dois blocos com o mesmo número
  // coexistam na mesma sessão, mesmo que algum caminho de código futuro falhe.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mapeamento_blocos_unico ON mapeamento_blocos (sessao_id, numero_bloco)
  `).catch(e => console.error('[MAPEAMENTO] Erro ao criar índice único:', e.message));
}).catch(console.error);

// Criar sessão de mapeamento
app.post('/api/mapeamento/sessao', autenticarAdm, async (req, res) => {
  try {
    const { nome, prefixos, prefixo_base, total_blocos, lado, rua } = req.body;
    if (!total_blocos) return res.status(400).json({ erro: 'Dados obrigatórios faltando' });

    // Suporte a array de prefixos (novo) ou prefixo_base único (legado)
    const listaPrefixos = prefixos || Array.from({length: total_blocos}, () => prefixo_base);

    const id = uuidv4();
    await pool.query(
      'INSERT INTO mapeamento_sessoes (id, nome, prefixo_base, total_blocos) VALUES ($1,$2,$3,$4)',
      [id, nome || `Mapeamento ${new Date().toLocaleDateString('pt-BR')}`, listaPrefixos[0] || prefixo_base, total_blocos]
    );

    for (let b = 0; b < total_blocos; b++) {
      const blocoId = uuidv4();
      const prefixo = listaPrefixos[b] || listaPrefixos[0];
      await pool.query(
        'INSERT INTO mapeamento_blocos (id,sessao_id,numero_bloco,prefixo) VALUES ($1,$2,$3,$4)',
        [blocoId, id, b + 1, prefixo]
      );
    }
    res.json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Listar sessões
app.get('/api/mapeamento/sessoes', autenticarAdm, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM mapeamento_sessoes ORDER BY criado_em DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Buscar sessão com progresso
app.get('/api/mapeamento/sessao/:id', async (req, res) => {
  try {
    const { rows: [sessao] } = await pool.query('SELECT * FROM mapeamento_sessoes WHERE id=$1', [req.params.id]);
    if (!sessao) return res.status(404).json({ erro: 'Sessão não encontrada' });
    const { rows: blocos } = await pool.query('SELECT * FROM mapeamento_blocos WHERE sessao_id=$1 ORDER BY numero_bloco', [req.params.id]);
    for (const b of blocos) {
      const { rows: niveis } = await pool.query('SELECT * FROM mapeamento_niveis WHERE bloco_id=$1 ORDER BY nivel', [b.id]);
      b.niveis = niveis;
    }
    res.json({ ...sessao, blocos });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Buscar bloco pelo número bipado
app.get('/api/mapeamento/bloco', async (req, res) => {
  try {
    const { sessao_id, numero } = req.query;
    const { rows } = await pool.query(
      'SELECT * FROM mapeamento_blocos WHERE sessao_id=$1 AND numero_bloco=$2',
      [sessao_id, parseInt(numero)]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Bloco não encontrado' });
    const bloco = rows[0];
    const { rows: niveis } = await pool.query(
      'SELECT * FROM mapeamento_niveis WHERE bloco_id=$1 ORDER BY nivel',
      [bloco.id]
    );
    res.json({ ...bloco, niveis });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Iniciar bloco: cria os níveis com a quantidade informada (idempotente)
app.patch('/api/mapeamento/bloco/:id/iniciar', async (req, res) => {
  try {
    const totalNiveis = parseInt(req.body.total_niveis);
    if (!totalNiveis || totalNiveis < 1 || totalNiveis > 50) {
      return res.status(400).json({ erro: 'Quantidade de níveis inválida' });
    }

    const { rows: [bloco] } = await pool.query('SELECT * FROM mapeamento_blocos WHERE id=$1', [req.params.id]);
    if (!bloco) return res.status(404).json({ erro: 'Bloco não encontrado' });

    const { rows: existentes } = await pool.query(
      'SELECT * FROM mapeamento_niveis WHERE bloco_id=$1 ORDER BY nivel', [req.params.id]
    );
    if (existentes.length) {
      // Já iniciado (ex.: reload de página) — apenas devolve o que já existe
      return res.json({ niveis: existentes });
    }

    const prefixo = bloco.prefixo || '';
    const niveisCriados = [];
    for (let n = 0; n < totalNiveis; n++) {
      const nivel_str = String(n).padStart(2, '0');
      const novo_nome = prefixo ? `${prefixo} ${nivel_str}` : nivel_str;
      const nivelId = uuidv4();
      await pool.query(
        'INSERT INTO mapeamento_niveis (id,bloco_id,sessao_id,nivel,novo_nome) VALUES ($1,$2,$3,$4,$5)',
        [nivelId, req.params.id, bloco.sessao_id, n, novo_nome]
      );
      niveisCriados.push({ id: nivelId, bloco_id: req.params.id, sessao_id: bloco.sessao_id, nivel: n, novo_nome, id_local_bipado: null, status: 'pendente' });
    }
    res.json({ niveis: niveisCriados });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Registrar bipagem de nível
app.patch('/api/mapeamento/nivel/:id', async (req, res) => {
  try {
    const { id_local_bipado, status } = req.body;
    // Verificar duplicata
    if (id_local_bipado) {
      const { rows } = await pool.query(
        'SELECT n.nivel, b.numero_bloco FROM mapeamento_niveis n JOIN mapeamento_blocos b ON b.id=n.bloco_id WHERE n.id_local_bipado=$1',
        [id_local_bipado]
      );
      if (rows.length) return res.status(409).json({ erro: `Código já bipado no Bloco ${rows[0].numero_bloco}, Nível ${rows[0].nivel}` });
    }
    await pool.query(
      'UPDATE mapeamento_niveis SET id_local_bipado=$1, status=$2 WHERE id=$3',
      [id_local_bipado || null, status || 'mapeado', req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Refazer bloco (limpar bipagens)
app.patch('/api/mapeamento/bloco/:id/refazer', async (req, res) => {
  try {
    await pool.query('UPDATE mapeamento_niveis SET id_local_bipado=NULL, status=$1 WHERE bloco_id=$2', ['pendente', req.params.id]);
    await pool.query('UPDATE mapeamento_blocos SET status=$1 WHERE id=$2', ['pendente', req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Confirmar bloco
app.patch('/api/mapeamento/bloco/:id/confirmar', async (req, res) => {
  try {
    await pool.query('UPDATE mapeamento_blocos SET status=$1 WHERE id=$2', ['confirmado', req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Excluir sessão de mapeamento (cascata)
app.delete('/api/mapeamento/sessao/:id', autenticarAdm, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM mapeamento_niveis WHERE sessao_id=$1', [id]);
    await pool.query('DELETE FROM mapeamento_blocos WHERE sessao_id=$1', [id]);
    await pool.query('DELETE FROM mapeamento_sessoes WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Renomear sessão de mapeamento
app.patch('/api/mapeamento/sessao/:id/nome', autenticarAdm, async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome inválido' });
    await pool.query('UPDATE mapeamento_sessoes SET nome=$1 WHERE id=$2', [nome.trim(), req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Editar total de blocos da sessão (adiciona ou remove blocos no final)
app.patch('/api/mapeamento/sessao/:id/blocos', autenticarAdm, async (req, res) => {
  const client = await pool.connect();
  try {
    const novoTotal = parseInt(req.body.total_blocos);
    if (!novoTotal || novoTotal < 1) { return res.status(400).json({ erro: 'Quantidade inválida' }); }

    await client.query('BEGIN');
    // Trava a sessão até o fim da transação: se duas requisições chegarem juntas
    // (ex.: clique duplo no botão Salvar), a segunda espera a primeira terminar
    // e enxerga a contagem já atualizada, evitando blocos duplicados.
    await client.query('SELECT id FROM mapeamento_sessoes WHERE id=$1 FOR UPDATE', [req.params.id]);

    const { rows: blocos } = await client.query(
      'SELECT * FROM mapeamento_blocos WHERE sessao_id=$1 ORDER BY numero_bloco', [req.params.id]
    );
    const atual = blocos.length;

    if (novoTotal === atual) {
      await client.query('COMMIT');
      return res.json({ ok: true, total_blocos: novoTotal });
    }

    if (novoTotal < atual) {
      // Remove os blocos excedentes do final (e seus níveis)
      const idsRemover = blocos.filter(b => b.numero_bloco > novoTotal).map(b => b.id);
      if (idsRemover.length) {
        await client.query('DELETE FROM mapeamento_niveis WHERE bloco_id = ANY($1)', [idsRemover]);
        await client.query('DELETE FROM mapeamento_blocos WHERE id = ANY($1)', [idsRemover]);
      }
    } else {
      if (atual === 0) { const err = new Error('Sessão sem blocos para usar como referência'); err.status = 400; throw err; }

      // Descobre o prefixo do último bloco e o passo de incremento entre colunas
      function prefixoDoBloco(bloco) {
        return bloco.prefixo || '';
      }

      let passo = 2;
      const ultimoPrefixo = prefixoDoBloco(blocos[atual - 1]);
      if (atual >= 2) {
        const penultimoPrefixo = prefixoDoBloco(blocos[atual - 2]);
        const numUlt = parseInt(ultimoPrefixo.split(' ').pop());
        const numPen = parseInt(penultimoPrefixo.split(' ').pop());
        if (!isNaN(numUlt) && !isNaN(numPen) && numUlt !== numPen) passo = numUlt - numPen;
      }

      const partes = ultimoPrefixo.split(' ');
      const colStr = partes.pop();
      const head = partes.join(' ');
      const padLen = colStr.length;
      let colAtual = parseInt(colStr) || 0;

      for (let b = atual; b < novoTotal; b++) {
        colAtual += passo;
        const novoPrefixo = `${head} ${String(colAtual).padStart(padLen, '0')}`;
        const blocoId = uuidv4();
        await client.query(
          'INSERT INTO mapeamento_blocos (id,sessao_id,numero_bloco,prefixo) VALUES ($1,$2,$3,$4)',
          [blocoId, req.params.id, b + 1, novoPrefixo]
        );
      }
    }


    await client.query('UPDATE mapeamento_sessoes SET total_blocos=$1 WHERE id=$2', [novoTotal, req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, total_blocos: novoTotal });
  } catch(e) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(e.status || 500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

// Exportar sessão como JSON para gerar Excel no frontend
app.get('/api/mapeamento/sessao/:id/exportar', async (req, res) => {
  try {
    const { rows: niveis } = await pool.query(`
      SELECT b.numero_bloco, n.nivel, n.novo_nome, n.id_local_bipado, n.status
      FROM mapeamento_niveis n
      JOIN mapeamento_blocos b ON b.id = n.bloco_id
      WHERE n.sessao_id=$1
      ORDER BY b.numero_bloco, n.nivel
    `, [req.params.id]);
    res.json(niveis);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Total de locais altos cadastrados
app.get('/api/locais-altos', autenticarAdm, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) as total, MAX(atualizado_em) as atualizado FROM locais_altos');
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── EXPEDIÇÃO — QRY 180 ──────────────────────────────────

// Importar QRY 180 (ADM de expedição)
app.post('/api/expedicao/importar', autenticarAdm, upload.single('file'), async (req, res) => {
  try {
    // Usar ExcelJS que suporta arquivos grandes sem corrupção
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];

    // Ler cabeçalhos da primeira linha
    const headers = {};
    ws.getRow(1).eachCell((cell, col) => { headers[col] = String(cell.value || '').trim(); });

    // Mapear colunas por nome
    const colIdx = {};
    Object.entries(headers).forEach(([col, nome]) => { colIdx[nome] = parseInt(col); });

    function getCel(row, nomes) {
      for (const n of nomes) {
        if (colIdx[n] !== undefined) {
          const v = row.getCell(colIdx[n]).value;
          if (v !== null && v !== undefined && v !== '') return String(v).replace(/_x000D_|\r/g,'').trim();
        }
      }
      return '';
    }

    // Processar linhas
    const data = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      data.push(row);
    });

    // Excluir canais INT e PSV
    const semCanalExcluido = data.filter(r => {
      const canal = getCel(r, ['Canal']).toUpperCase();
      return canal !== 'INT' && canal !== 'PSV';
    });

    // Linhas prontas: Nota Fiscal Aceita
    const validos = semCanalExcluido.filter(r => getCel(r, ['Evento']).toUpperCase() === 'NOTA FISCAL ACEITA');

    // Índice fixo da coluna Y (transportadora = Nome, posição 25)
    const COL_TRANSP = 25;
    function getTransp(row) {
      const v = row.getCell(COL_TRANSP).value;
      return v ? String(v).replace(/_x000D_|\r/g,'').trim() : '';
    }

    // Agrupar pedidos prontos por número de entrega
    const pedidos = {};
    for (const r of validos) {
      const entrega = getCel(r, ['Entrega']);
      if (!entrega) continue;
      if (!pedidos[entrega]) {
        pedidos[entrega] = {
          entrega,
          ped_cliente: getCel(r, ['Ped. Cliente','Ped.Cliente']),
          data_limite: getCel(r, ['Data Limite','Data limite']),
          data_entrega: getCel(r, ['Data entrega','Data Entrega']),
          evento: getCel(r, ['Evento']),
          dt_evento: getCel(r, ['Dt Evento','Dt. Evento']),
          operador: getCel(r, ['Operador']),
          mega_rota: getCel(r, ['Mega Rota','Mega rota','MegaRota']),
          transportadora: getTransp(r) || getCel(r, ['Nome Contrato','Nome contrato']),
          uf: getCel(r, ['Uf','UF']),
          nf: getCel(r, ['Nf.','NF']),
          serie: getCel(r, ['Serie','Série']),
          onda: getCel(r, ['Onda']),
          log: getCel(r, ['Grupo Classe Local']),
          itens: []
        };
      }
      pedidos[entrega].itens.push({
        sku: getCel(r, ['Item']),
        nome: getCel(r, ['Nome']),
        qtd: getCel(r, ['Qtd. Peças','Qtd. pecas','Qtd'])
      });
    }
    const lista = Object.values(pedidos);

    // Resumo de todas as etapas por entrega única
    const entregasPorEtapa = {};
    for (const r of semCanalExcluido) {
      const entrega = getCel(r, ['Entrega']);
      const evento = getCel(r, ['Evento']);
      if (!entrega || !evento) continue;
      const chave = entrega + '|' + evento;
      if (entregasPorEtapa[chave]) continue;
      entregasPorEtapa[chave] = {
        entrega,
        evento,
        transportadora: getTransp(r) || getCel(r, ['Nome Contrato','Nome contrato']),
        data_limite: getCel(r, ['Data Limite','Data limite'])
      };
    }
    const resumoEtapas = Object.values(entregasPorEtapa);

    // Criar tabelas se não existirem
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expedicao_pedidos (
        id TEXT PRIMARY KEY,
        entrega TEXT NOT NULL,
        ped_cliente TEXT,
        data_limite TEXT,
        data_entrega TEXT,
        evento TEXT,
        dt_evento TEXT,
        operador TEXT,
        mega_rota TEXT,
        transportadora TEXT,
        uf TEXT,
        nf TEXT,
        serie TEXT,
        onda TEXT,
        log TEXT,
        itens JSONB,
        flagado BOOLEAN DEFAULT false,
        concluido BOOLEAN DEFAULT false,
        concluido_em TIMESTAMPTZ,
        concluido_por TEXT,
        importado_em TIMESTAMPTZ DEFAULT now()
      );
    `);
    await pool.query(`ALTER TABLE expedicao_pedidos ADD COLUMN IF NOT EXISTS flagado BOOLEAN DEFAULT false;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expedicao_etapas_resumo (
        id TEXT PRIMARY KEY,
        entrega TEXT,
        evento TEXT,
        transportadora TEXT,
        data_limite TEXT
      );
    `);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM expedicao_pedidos');
      await client.query('DELETE FROM expedicao_etapas_resumo');

      // Inserir pedidos em lote (muito mais rápido que um INSERT por vez)
      if (lista.length) {
        const LOTE = 200;
        for (let i = 0; i < lista.length; i += LOTE) {
          const lote = lista.slice(i, i + LOTE);
          const valores = lote.map((p, j) => {
            const base = j * 16;
            return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15},$${base+16})`;
          }).join(',');
          const params = lote.flatMap(p => [
            uuidv4(), p.entrega, p.ped_cliente, p.data_limite, p.data_entrega, p.evento, p.dt_evento,
            p.operador, p.mega_rota, p.transportadora, p.uf, p.nf, p.serie, p.onda, p.log, JSON.stringify(p.itens)
          ]);
          await client.query(
            `INSERT INTO expedicao_pedidos (id,entrega,ped_cliente,data_limite,data_entrega,evento,dt_evento,operador,mega_rota,transportadora,uf,nf,serie,onda,log,itens) VALUES ${valores}`,
            params
          );
        }
      }

      // Inserir resumo de etapas em lote
      if (resumoEtapas.length) {
        const LOTE = 500;
        for (let i = 0; i < resumoEtapas.length; i += LOTE) {
          const lote = resumoEtapas.slice(i, i + LOTE);
          const valores = lote.map((_, j) => `($${j*5+1},$${j*5+2},$${j*5+3},$${j*5+4},$${j*5+5})`).join(',');
          const params = lote.flatMap(e => [uuidv4(), e.entrega, e.evento, e.transportadora, e.data_limite]);
          await client.query(`INSERT INTO expedicao_etapas_resumo (id,entrega,evento,transportadora,data_limite) VALUES ${valores}`, params);
        }
      }

      await client.query('COMMIT');
    } catch(e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ importados: lista.length, total_linhas: validos.length, total_etapas: resumoEtapas.length });
  } catch(e) {
    res.status(500).json({ erro: 'Erro ao processar QRY 180: ' + e.message });
  }
});

// Listar pedidos de expedição (ADM)
app.get('/api/expedicao/pedidos', autenticarAdm, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM expedicao_pedidos ORDER BY data_limite, entrega');
    rows.forEach(r => { try { r.itens = typeof r.itens === 'string' ? JSON.parse(r.itens) : r.itens; } catch(e){ r.itens=[]; } });
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Listar pedidos para o coletor (só flagados)
app.get('/api/expedicao/coletor', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM expedicao_pedidos WHERE flagado=true ORDER BY data_limite, entrega');
    rows.forEach(r => { try { r.itens = typeof r.itens === 'string' ? JSON.parse(r.itens) : r.itens; } catch(e){ r.itens=[]; } });
    res.json(rows);
  } catch(e) {
    res.json([]);
  }
});

// Resumo de etapas por transportadora + data limite (uso geral, ADM e coletor)
app.get('/api/expedicao/resumo-etapas', async (req, res) => {
  try {
    const { transportadora, data_limite } = req.query;
    if (!transportadora || !data_limite) return res.json([]);
    const { rows } = await pool.query(
      `SELECT evento, COUNT(*) as total FROM expedicao_etapas_resumo
       WHERE transportadora=$1 AND data_limite=$2
       GROUP BY evento ORDER BY total DESC`,
      [transportadora, data_limite]
    );
    res.json(rows);
  } catch(e) {
    res.json([]);
  }
});

// Resumo de etapas em lote — recebe lista de {transportadora, data_limite} e devolve mapa
app.post('/api/expedicao/resumo-etapas-lote', async (req, res) => {
  try {
    const { chaves } = req.body;
    if (!Array.isArray(chaves) || !chaves.length) return res.json({});
    const { rows } = await pool.query('SELECT evento, transportadora, data_limite FROM expedicao_etapas_resumo');
    const resultado = {};
    for (const c of chaves) {
      const chaveStr = c.transportadora + '|' + c.data_limite;
      if (!resultado[chaveStr]) resultado[chaveStr] = {};
    }
    for (const r of rows) {
      const chaveStr = r.transportadora + '|' + r.data_limite;
      if (resultado[chaveStr] !== undefined) {
        resultado[chaveStr][r.evento] = (resultado[chaveStr][r.evento] || 0) + 1;
      }
    }
    res.json(resultado);
  } catch(e) {
    res.json({});
  }
});

// Flegar / desflegar pedido (ADM)
// Flegar em massa (ADM) — rota separada sem conflito
app.patch('/api/expedicao/flegar-massa', autenticarAdm, async (req, res) => {
  try {
    const { flagado, prazo, transportadora } = req.body;
    if (transportadora) {
      const r = await pool.query('UPDATE expedicao_pedidos SET flagado=$1 WHERE transportadora=$2', [!!flagado, transportadora]);
      res.json({ ok: true, atualizados: r.rowCount });
    } else if (prazo) {
      // Compensar fuso Brasil (UTC-3): subtrair 3 horas do UTC para pegar o dia correto de Brasília
      const agora = new Date();
      const brasilOffset = 3 * 60 * 60 * 1000; // UTC-3
      const agoraBrasil = new Date(agora.getTime() - brasilOffset);
      const hojeUTC = Date.UTC(agoraBrasil.getUTCFullYear(), agoraBrasil.getUTCMonth(), agoraBrasil.getUTCDate());
      const amanhaUTC = hojeUTC + 86400000;


      const { rows } = await pool.query('SELECT id, data_limite FROM expedicao_pedidos');
      const ids = rows.filter(p => {
        if (!p.data_limite) return false;
        const dataStr = p.data_limite.trim().split(' ')[0];
        const partes = dataStr.split('/');
        if (partes.length < 3) return false;
        const dia = parseInt(partes[0], 10);
        const mes = parseInt(partes[1], 10) - 1;
        const ano = parseInt(partes[2], 10);
        if (isNaN(dia) || isNaN(mes) || isNaN(ano)) return false;
        const dUTC = Date.UTC(ano, mes, dia);
        if (prazo==='atrasado') return dUTC < hojeUTC;
        if (prazo==='limite') return dUTC === hojeUTC;
        if (prazo==='D+1') return dUTC === amanhaUTC;
        if (prazo==='adiantado') return dUTC > amanhaUTC;
        return false;
      }).map(p => p.id);

      if (ids.length) await pool.query(`UPDATE expedicao_pedidos SET flagado=$1 WHERE id = ANY($2::text[])`, [!!flagado, ids]);
      res.json({ ok: true, atualizados: ids.length });
    } else {
      await pool.query('UPDATE expedicao_pedidos SET flagado=$1', [!!flagado]);
      res.json({ ok: true });
    }
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Excluir todos os pedidos de expedição (ADM)
app.delete('/api/expedicao/pedidos', autenticarAdm, async (req, res) => {
  try {
    await pool.query('DELETE FROM expedicao_pedidos');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/expedicao/pedidos/:id/flegar', autenticarAdm, async (req, res) => {
  try {
    const { flagado } = req.body;
    await pool.query('UPDATE expedicao_pedidos SET flagado=$1 WHERE id=$2', [!!flagado, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/expedicao/pedidos/:id/concluir', async (req, res) => {
  try {
    const { concluido, usuario } = req.body;
    await pool.query(
      'UPDATE expedicao_pedidos SET concluido=$1, concluido_em=$2, concluido_por=$3 WHERE id=$4',
      [!!concluido, concluido ? new Date() : null, usuario || null, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Rotas SPA
app.get('/adm', (req, res) => res.sendFile(path.join(__dirname, '../public/adm/index.html')));
app.get('/adm/*', (req, res) => res.sendFile(path.join(__dirname, '../public/adm/index.html')));
app.get('/coletor', (req, res) => res.sendFile(path.join(__dirname, '../public/coletor/index.html')));
app.get('/coletor/*', (req, res) => res.sendFile(path.join(__dirname, '../public/coletor/index.html')));
app.get('/curva-abc', (req, res) => res.sendFile(path.join(__dirname, '../public/curva-abc/index.html')));
app.get('/curva-abc/*', (req, res) => res.sendFile(path.join(__dirname, '../public/curva-abc/index.html')));
app.get('/armazenagem', (req, res) => res.sendFile(path.join(__dirname, '../public/armazenagem/index.html')));
app.get('/transitorio', (req, res) => res.sendFile(path.join(__dirname, '../public/transitorio/index.html')));
app.get('/mapeamento', (req, res) => res.sendFile(path.join(__dirname, '../public/mapeamento/index.html')));
app.get('/faturamento', (req, res) => res.sendFile(path.join(__dirname, '../public/faturamento/index.html')));
app.get('/expedicao', (req, res) => res.sendFile(path.join(__dirname, '../public/expedicao/index.html')));
app.get('/expedicao-coletor', (req, res) => res.sendFile(path.join(__dirname, '../public/expedicao-coletor/index.html')));

initDb().then(() => {
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}).catch(err => {
  console.error('Erro ao iniciar banco de dados:', err);
  process.exit(1);
});
