// TTS com clonagem de voz (Fish Audio) + usuarios com login. Sem dependencias (Node 18+).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
let ENV = {};
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) ENV[m[1]] = m[2]; }); } catch {}
const cfg = (k, d = '') => process.env[k] || ENV[k] || d;
const PORT = cfg('PORT', '3000'), API = 'https://api.fish.audio';
const KEY = cfg('FISH_API_KEY'), MODEL = cfg('FISH_MODEL', 's1'), SENHA = cfg('SENHA_ACESSO'), MAX = +cfg('MAX_CHARS', '1000');
const ABERTO = cfg('CADASTRO', 'sim') !== 'nao', LIM_NOVOS = +cfg('LIMITE_NOVOS', '500'), APROVAR = cfg('APROVAR_NOVOS', 'nao') === 'sim';
const DATA = cfg('DATA_DIR', __dirname);
const D = (...p) => path.join(DATA, ...p), APP = (...p) => path.join(__dirname, ...p);
const AUDIO = /\.(wav|mp3|m4a|ogg|flac)$/i;
fs.mkdirSync(D('vozes'), { recursive: true }); fs.mkdirSync(D('saidas'), { recursive: true });
if (DATA !== __dirname && fs.existsSync(APP('vozes'))) fs.cpSync(APP('vozes'), D('vozes'), { recursive: true, force: false, errorOnExist: false });
// locutores: vozes/feminina/*.mp3 e vozes/masculina/*.mp3 (arquivos soltos em vozes/ ficam em "outras")
const GEN = ['feminina', 'masculina'];
function listaVozes() {
  const o = { feminina: [], masculina: [], outras: [] };
  const ja = fs.readdirSync(D('vozes')).map(x => x.toLowerCase());
  for (const g of GEN) if (!ja.includes(g)) fs.mkdirSync(D('vozes', g), { recursive: true });
  for (const d of fs.readdirSync(D('vozes'), { withFileTypes: true })) {   // aceita MASCULINA, masculina, Masculina...
    const g = d.name.toLowerCase();
    if (d.isDirectory() && GEN.includes(g)) o[g].push(...fs.readdirSync(D('vozes', d.name)).filter(f => AUDIO.test(f)).sort().map(f => d.name + '/' + f));
    else if (d.isFile() && AUDIO.test(d.name)) o.outras.push(d.name);
  }
  o.outras.sort(); return o;
}
function vozOk(v) {
  const p = String(v || '').split('/'); if (p.length > 2 || (p.length === 2 && !GEN.includes(p[0].toLowerCase()))) return null;
  const f = p[p.length - 1]; if (f !== path.basename(f) || !AUDIO.test(f)) return null;
  return fs.existsSync(D('vozes', ...p)) ? p.join('/') : null;
}

// ---------- usuarios ----------
const upath = D('usuarios.json');
let U = fs.existsSync(upath) ? JSON.parse(fs.readFileSync(upath, 'utf8')) : {};
const salvarU = () => fs.writeFileSync(upath, JSON.stringify(U, null, 2));
const mkhash = (s, salt) => crypto.scryptSync(s, salt, 32).toString('hex');
function criar(nome, senha, limite, admin) {
  const salt = crypto.randomBytes(16).toString('hex');
  U[nome] = { salt, hash: mkhash(senha, salt), admin: !!admin, limite: Math.max(0, parseInt(limite) || 0), usados: 0, criado: new Date().toISOString() };
  salvarU();
}
if (!Object.keys(U).length) {
  if (!SENHA || SENHA.length < 6) { console.error('Primeiro uso: defina SENHA_ACESSO (minimo 6 caracteres). Ela sera a senha do usuario "admin".'); process.exit(1); }
  criar('admin', SENHA, 0, true); console.log('Usuario "admin" criado com a senha de SENHA_ACESSO.');
}
const sp = D('segredo.txt');
if (!fs.existsSync(sp)) fs.writeFileSync(sp, crypto.randomBytes(32).toString('hex'));
const SEG = fs.readFileSync(sp, 'utf8').trim();
const tok = n => crypto.createHmac('sha256', SEG).update(n + U[n].hash).digest('hex');
const igual = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const quem = req => { const m = (req.headers.cookie || '').match(/(?:^|;\s*)sessao=([a-z0-9-]+)\.([a-f0-9]+)/); return m && U[m[1]] && !U[m[1]].pendente && igual(tok(m[1]), m[2]) ? m[1] : null; };
const falhas = {}; const ipDe = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const cads = {}, nomeOk = n => /^[a-z0-9-]{3,20}$/.test(n);

// ---------- voz ----------
const cachePath = D('vozes', 'cache.json');
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
async function voiceId(file) {
  const bin = fs.readFileSync(D('vozes', file)), stamp = crypto.createHash('sha1').update(bin).digest('hex');
  const hit = Object.values(cache).find(x => x.stamp === stamp); // mesmo audio = mesma voz, mesmo se mudar de pasta
  if (hit) return hit.id;
  const fd = new FormData();
  fd.append('type', 'tts'); fd.append('train_mode', 'fast'); fd.append('visibility', 'private');
  fd.append('title', path.parse(file).name); fd.append('voices', new Blob([bin]), file);
  const txt = path.join(path.dirname(D('vozes', file)), path.parse(file).name + '.txt');
  if (fs.existsSync(txt)) fd.append('texts', fs.readFileSync(txt, 'utf8').trim());
  const r = await fetch(API + '/model', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Erro ao criar voz: ' + (j.message || r.status));
  cache[file] = { id: j._id || j.id, stamp }; fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  return cache[file].id;
}
async function gerar(user, { texto, voz, velocidade, volume }) {
  if (!KEY) throw new Error('Falta FISH_API_KEY no servidor');
  if (!texto || !texto.trim()) throw new Error('Digite um texto');
  if (texto.length > MAX) throw new Error('Texto muito longo (maximo ' + MAX + ' caracteres)');
  const u = U[user];
  if (u.limite && u.usados + texto.length > u.limite) throw new Error('Créditos insuficientes: restam ' + Math.max(0, u.limite - u.usados) + ' e este texto usa ' + texto.length + '. Fale com o administrador.');
  const body = { text: texto, format: 'mp3', normalize: true,
    prosody: { speed: Math.min(2, Math.max(0.5, Number(velocidade) || 1)), volume: Math.min(10, Math.max(-10, Number(volume) || 0)) } };
  if (voz) {
    voz = vozOk(voz); if (!voz) throw new Error('Voz nao encontrada');
    body.reference_id = await voiceId(voz);
  }
  const r = await fetch(API + '/v1/tts', { method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', model: MODEL }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Erro na geracao (' + r.status + '): ' + (await r.text()).slice(0, 200));
  const buf = Buffer.from(await r.arrayBuffer());
  const nome = user + '_' + Date.now() + '_' + (voz ? path.parse(voz).name.replace(/[^\w-]/g, '') : 'padrao') + '.mp3';
  fs.writeFileSync(D('saidas', nome), buf); fs.writeFileSync(D('saidas', nome + '.txt'), texto);
  u.usados += texto.length; salvarU();
  return nome;
}

// ---------- admin ----------
function admin(me, b) {
  const nome = String(b.nome || '').toLowerCase().trim();
  if (b.acao === 'criar') {
    if (!nomeOk(nome)) throw new Error('Usuario: 3 a 20 caracteres, so letras minusculas, numeros e hifen');
    if (U[nome]) throw new Error('Esse usuario ja existe');
    if (String(b.senha || '').length < 6) throw new Error('Senha com no minimo 6 caracteres');
    return criar(nome, String(b.senha), b.limite, b.admin);
  }
  if (!Object.hasOwn(U, nome)) throw new Error('Usuario nao encontrado');
  if (b.acao === 'aprovar') { delete U[nome].pendente; return salvarU(); }
  if (b.acao === 'zerar') { U[nome].usados = 0; return salvarU(); }
  if (b.acao === 'limite') { U[nome].limite = Math.max(0, parseInt(b.limite) || 0); return salvarU(); }
  if (b.acao === 'senha') {
    if (String(b.senha || '').length < 6) throw new Error('Senha com no minimo 6 caracteres');
    U[nome].salt = crypto.randomBytes(16).toString('hex'); U[nome].hash = mkhash(String(b.senha), U[nome].salt); return salvarU();
  }
  if (b.acao === 'excluir') {
    if (nome === me) throw new Error('Voce nao pode excluir a si mesmo');
    delete U[nome]; return salvarU();
  }
  throw new Error('Acao invalida');
}

const ck = (req, id) => `sessao=${id}.${tok(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
const json = (res, code, obj, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(obj)); };
const html = (res, f) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(APP(f))); };
const corpo = async (req, lim = 1e5) => { let raw = ''; for await (const c of req) { raw += c; if (raw.length > lim) break; } try { return JSON.parse(raw); } catch { return {}; } };

http.createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]), get = req.method === 'GET';
    if (req.method === 'POST' && u === '/api/login') {
      const ip = ipDe(req), f = falhas[ip] || { n: 0, ate: 0 };
      if (f.ate > Date.now()) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 15 minutos.' });
      const b = await corpo(req, 1e4), ident = String(b.usuario || '').toLowerCase().trim(), s = String(b.senha || '');
      const nome = Object.hasOwn(U, ident) ? ident : Object.keys(U).find(k => U[k].email === ident);
      if (!(nome && igual(mkhash(s, U[nome].salt), U[nome].hash))) {
        f.n++; if (f.n >= 5) { f.ate = Date.now() + 15 * 60e3; f.n = 0; } falhas[ip] = f;
        return json(res, 401, { erro: 'Usuario ou senha incorretos' });
      }
      delete falhas[ip];
      if (U[nome].pendente) return json(res, 403, { erro: 'Sua conta aguarda aprovação do administrador.' });
      return json(res, 200, { ok: true }, { 'Set-Cookie': ck(req, nome) });
    }
    if (get && u === '/api/config') return json(res, 200, { cadastro: ABERTO });
    if (req.method === 'POST' && u === '/api/cadastro') {
      if (!ABERTO) return json(res, 403, { erro: 'Cadastro desativado.' });
      const ip = ipDe(req), c = cads[ip] = (cads[ip] || []).filter(t => t > Date.now() - 3600e3);
      if (c.length >= 5) return json(res, 429, { erro: 'Muitos cadastros deste endereço. Tente mais tarde.' });
      const b = await corpo(req, 1e4), email = String(b.email || '').toLowerCase().trim(), senha = String(b.senha || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 80) return json(res, 400, { erro: 'E-mail inválido' });
      if (senha.length < 6) return json(res, 400, { erro: 'A senha precisa ter no mínimo 6 caracteres' });
      if (Object.values(U).some(x => x.email === email)) return json(res, 400, { erro: 'Este e-mail já está cadastrado' });
      c.push(Date.now());
      const id = 'u' + crypto.createHash('sha1').update(email).digest('hex').slice(0, 12);
      criar(id, senha, LIM_NOVOS, false); Object.assign(U[id], { email, nome: email.split('@')[0], pendente: APROVAR }); salvarU();
      return APROVAR ? json(res, 200, { pendente: true }) : json(res, 200, { ok: true }, { 'Set-Cookie': ck(req, id) });
    }
    if (get && (u === '/logo.png' || u === '/logo-sm.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); return res.end(fs.readFileSync(APP(u.slice(1))));
    }
    if (u === '/api/sair') return json(res, 200, { ok: true }, { 'Set-Cookie': 'sessao=; HttpOnly; Path=/; Max-Age=0' });
    const me = quem(req);
    if (!me) {
      if (get && (u === '/' || u === '/index.html' || u === '/admin')) return html(res, 'login.html');
      return json(res, 401, { erro: 'Nao autorizado' });
    }
    const adm = U[me].admin;
    if (get && (u === '/' || u === '/index.html')) return html(res, 'index.html');
    if (get && u === '/admin') return adm ? html(res, 'admin.html') : (res.writeHead(302, { Location: '/' }), res.end());
    if (get && u === '/api/eu') return json(res, 200, { usuario: U[me].nome || me, admin: adm, limite: U[me].limite, usados: U[me].usados });
    if (get && u === '/api/vozes') return json(res, 200, listaVozes());
    if (get && u === '/api/historico')
      return json(res, 200, fs.readdirSync(D('saidas')).filter(f => f.startsWith(me + '_') && f.endsWith('.mp3')).sort().reverse().slice(0, 50)
        .map(f => ({ arquivo: f, texto: fs.existsSync(D('saidas', f + '.txt')) ? fs.readFileSync(D('saidas', f + '.txt'), 'utf8') : '' })));
    if (get && u.startsWith('/saidas/')) {
      const f = path.basename(u), p = D('saidas', f);
      if (!f.startsWith(me + '_') || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(fs.readFileSync(p));
    }
    if (req.method === 'POST' && u === '/api/gerar') return json(res, 200, { arquivo: await gerar(me, await corpo(req)) });
    if (u.startsWith('/api/usuarios')) {
      if (!adm) return json(res, 403, { erro: 'Somente administrador' });
      if (get) return json(res, 200, Object.entries(U).map(([nome, x]) => ({ nome, email: x.email || '', pendente: !!x.pendente, admin: x.admin, limite: x.limite, usados: x.usados })));
      if (req.method === 'POST') { admin(me, await corpo(req)); return json(res, 200, { ok: true }); }
    }
    res.writeHead(404); res.end();
  } catch (e) { json(res, 500, { erro: e.message }); }
}).listen(PORT, '0.0.0.0', () => console.log('Sistema TTS rodando na porta ' + PORT));
