// TTS com clonagem de voz (Fish Audio) + usuarios com login. Sem dependencias (Node 18+).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
let ENV = {};
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) ENV[m[1]] = m[2]; }); } catch {}
const cfg = (k, d = '') => process.env[k] || ENV[k] || d;
const PORT = cfg('PORT', '3000'), API = 'https://api.fish.audio';
const KEY = cfg('FISH_API_KEY'), MODEL = cfg('FISH_MODEL', 's1'), SENHA = cfg('SENHA_ACESSO'), MAX = +cfg('MAX_CHARS', '1000');
const ABERTO = cfg('CADASTRO', 'sim') !== 'nao', LIM_NOVOS = +cfg('LIMITE_NOVOS', '500'), APROVAR = cfg('APROVAR_NOVOS', 'nao') === 'sim';
const DATA = cfg('DATA_DIR', __dirname);
// ---------- compra de creditos via PIX ----------
const PIX_CHAVE = cfg('PIX_CHAVE'), PIX_NOME = cfg('PIX_NOME', 'LOCUTOR'), PIX_CIDADE = cfg('PIX_CIDADE', 'MACAPA'), WHATS = cfg('WHATSAPP').replace(/\D/g, '');
const PACOTES = cfg('PACOTES', '5000:10,15000:25,40000:50').split(',')
  .map(x => { const [c, v] = x.split(':'); return { creditos: parseInt(c), valor: parseFloat(String(v).replace(',', '.')) }; })
  .filter(p => p.creditos > 0 && p.valor > 0);
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
const limpa = (t, n) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, n) || 'X';
function crc16(t) { let c = 0xFFFF; for (let i = 0; i < t.length; i++) { c ^= t.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function brcode(valor) {
  const p = tlv('00', '01') + tlv('01', '11') + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', PIX_CHAVE)) + tlv('52', '0000') + tlv('53', '986')
    + tlv('54', valor.toFixed(2)) + tlv('58', 'BR') + tlv('59', limpa(PIX_NOME, 25)) + tlv('60', limpa(PIX_CIDADE, 15)) + tlv('62', tlv('05', '***')) + '6304';
  return p + crc16(p);
}
const D = (...p) => path.join(DATA, ...p), APP = (...p) => path.join(__dirname, ...p);
const AUDIO = /\.(wav|mp3|m4a|ogg|flac)$/i;
fs.mkdirSync(D('vozes'), { recursive: true }); fs.mkdirSync(D('saidas'), { recursive: true });
if (DATA !== __dirname && fs.existsSync(APP('vozes')))
  for (const f of fs.readdirSync(APP('vozes'))) if (!fs.existsSync(D('vozes', f))) fs.copyFileSync(APP('vozes', f), D('vozes', f));

// ---------- armazenamento: Firestore (gratis, nao perde dados) ou arquivos locais ----------
const FB = (() => {
  const raw = cfg('FIREBASE_SERVICE_ACCOUNT').trim(); if (!raw) return null;
  try { const c = JSON.parse(raw[0] === '{' ? raw : Buffer.from(raw, 'base64').toString('utf8')); c.private_key = String(c.private_key).replace(/\\n/g, '\n'); return c; }
  catch { console.error('FIREBASE_SERVICE_ACCOUNT invalido: cole o JSON da conta de servico (ou ele em base64).'); process.exit(1); }
})();
const GOOGLE_TOKEN = cfg('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'), FS_URL = cfg('FIRESTORE_URL', 'https://firestore.googleapis.com');
let tk = { v: '', exp: 0 };
async function tokenGoogle() {
  if (tk.v && tk.exp > Date.now() + 60e3) return tk.v;
  const b64u = x => Buffer.from(x).toString('base64url'), agora = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), c = b64u(JSON.stringify({ iss: FB.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: GOOGLE_TOKEN, iat: agora, exp: agora + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(h + '.' + c).sign(FB.private_key, 'base64url');
  const r = await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: h + '.' + c + '.' + sig }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Login no Google falhou: ' + (j.error_description || j.error || r.status));
  tk = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; return tk.v;
}
async function fsReq(metodo, caminho, corpo) {
  const r = await fetch(FS_URL + '/v1/projects/' + FB.project_id + '/databases/(default)/documents' + caminho,
    { method: metodo, headers: { Authorization: 'Bearer ' + await tokenGoogle(), 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !(r.status === 404 && metodo === 'GET')) throw new Error('Firestore ' + r.status + ': ' + ((j.error && j.error.message) || ''));
  return { status: r.status, j };
}
const fbSet = (col, id, txt) => fsReq('PATCH', '/' + col + '/' + encodeURIComponent(id), { fields: { d: { stringValue: txt } } });
const fbDel = (col, id) => fsReq('DELETE', '/' + col + '/' + encodeURIComponent(id));
const fbGet = async (col, id) => { const r = await fsReq('GET', '/' + col + '/' + encodeURIComponent(id)); return r.status === 404 ? null : (r.j.fields && r.j.fields.d ? r.j.fields.d.stringValue : null); };
async function fbList(col) {
  const out = []; let pg = '';
  do {
    const r = await fsReq('GET', '/' + col + '?pageSize=300' + (pg ? '&pageToken=' + encodeURIComponent(pg) : ''));
    for (const d of r.j.documents || []) if (d.fields && d.fields.d) out.push([decodeURIComponent(d.name.split('/').pop()), d.fields.d.stringValue]);
    pg = r.j.nextPageToken || '';
  } while (pg);
  return out;
}
// guarda um objeto { chave: registro }, um documento por chave (grava so o que mudou)
function loja(colecao, obj, arquivo) {
  const visto = {}; let fila = Promise.resolve(true), tentando = false;
  async function gravar() {
    let ok = true;
    for (const k of Object.keys(obj)) {
      const js = JSON.stringify(obj[k]);
      if (visto[k] !== js) try { await fbSet(colecao, k, js); visto[k] = js; } catch (e) { ok = false; console.error(e.message); }
    }
    for (const k of Object.keys(visto)) if (!Object.hasOwn(obj, k)) try { await fbDel(colecao, k); delete visto[k]; } catch (e) { ok = false; console.error(e.message); }
    if (!ok && !tentando) { tentando = true; setTimeout(() => { tentando = false; save(); }, 5000); }
    return ok;
  }
  function save() {
    if (!FB) { fs.writeFileSync(arquivo, JSON.stringify(obj, null, 2)); return Promise.resolve(true); }
    return fila = fila.then(gravar);
  }
  async function load() {
    if (!FB) { if (fs.existsSync(arquivo)) Object.assign(obj, JSON.parse(fs.readFileSync(arquivo, 'utf8'))); return; }
    for (const [id, js] of await fbList(colecao)) { obj[id] = JSON.parse(js); visto[id] = js; }
  }
  return { save, load, flush: () => fila };
}

// ---------- usuarios ----------
const U = {}, lojaU = loja('ia_usuarios', U, D('usuarios.json')), salvarU = () => lojaU.save();
const mkhash = (s, salt) => crypto.scryptSync(s, salt, 32).toString('hex');
function criar(nome, senha, limite, admin) {
  const salt = crypto.randomBytes(16).toString('hex');
  U[nome] = { salt, hash: mkhash(senha, salt), admin: !!admin, limite: Math.max(0, parseInt(limite) || 0), usados: 0, criado: new Date().toISOString() };
  salvarU();
}
let SEG = '';
const tok = n => crypto.createHmac('sha256', SEG).update(n + U[n].hash).digest('hex');
const igual = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const quem = req => { const m = (req.headers.cookie || '').match(/(?:^|;\s*)sessao=([a-z0-9-]+)\.([a-f0-9]+)/); return m && U[m[1]] && !U[m[1]].pendente && igual(tok(m[1]), m[2]) ? m[1] : null; };
const falhas = {}; const ipDe = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const cads = {}, nomeOk = n => /^[a-z0-9-]{3,20}$/.test(n);

// ---------- pagamento automatico (InfinitePay) ----------
const IP_HANDLE = cfg('INFINITEPAY_HANDLE').replace(/^\$/, ''), PUBLICO = cfg('PUBLIC_URL').replace(/\/+$/, ''), IP_API = 'https://api.checkout.infinitepay.io';
const PED = {}, lojaP = loja('ia_pedidos', PED, D('pedidos.json')), salvarP = () => lojaP.save();
const persistir = () => Promise.all([lojaU.flush(), lojaP.flush()]);
// confirma o pagamento direto na InfinitePay (o webhook nao tem assinatura, entao nunca confiamos so nele)
async function checar(p, extra = {}) {
  try {
    const r = await fetch(IP_API + '/payment_check', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: IP_HANDLE, order_nsu: p.id, ...extra }) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.success !== false && j.paid === true && Number(j.paid_amount) >= p.valor ? j : null;
  } catch { return null; }
}
function liberar(p, transacao) {
  if (p.status !== 'pendente') return false;
  p.status = 'pago'; p.pagoEm = new Date().toISOString(); p.transacao = String(transacao || '');
  salvarP();
  if (U[p.user]) { U[p.user].limite += p.creditos; salvarU(); }
  return true;
}

// ---------- voz ----------
const cachePath = D('vozes', 'cache.json');
const cache = {};
const salvarCache = async () => { if (!FB) return fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); try { await fbSet('config', 'vozes_cache', JSON.stringify(cache)); } catch (e) { console.error(e.message); } };
async function voiceId(file) {
  const bin = fs.readFileSync(D('vozes', file)), stamp = crypto.createHash('sha1').update(bin).digest('hex');
  if (cache[file] && cache[file].stamp === stamp) return cache[file].id;
  const fd = new FormData();
  fd.append('type', 'tts'); fd.append('train_mode', 'fast'); fd.append('visibility', 'private');
  fd.append('title', path.parse(file).name); fd.append('voices', new Blob([bin]), file);
  const txt = D('vozes', path.parse(file).name + '.txt');
  if (fs.existsSync(txt)) fd.append('texts', fs.readFileSync(txt, 'utf8').trim());
  const r = await fetch(API + '/model', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Erro ao criar voz: ' + (j.message || r.status));
  cache[file] = { id: j._id || j.id, stamp }; await salvarCache();
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
    voz = path.basename(String(voz));
    if (!AUDIO.test(voz) || !fs.existsSync(D('vozes', voz))) throw new Error('Voz nao encontrada');
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

const servidor = http.createServer(async (req, res) => {
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
    if (req.method === 'POST' && u === '/webhook-infinitepay') {
      const b = await corpo(req), id = String(b.order_nsu || '');
      if (!Object.hasOwn(PED, id)) return json(res, 400, { erro: 'Pedido desconhecido' });
      const p = PED[id];
      if (p.status === 'pago') return json(res, 200, { ok: true });
      if (!(await checar(p, { transaction_nsu: b.transaction_nsu, slug: b.invoice_slug }))) return json(res, 400, { erro: 'Pagamento nao confirmado' });
      liberar(p, b.transaction_nsu); await persistir(); return json(res, 200, { ok: true });
    }
    if (get && u === '/pago') {
      const q = new URL(req.url, 'http://x').searchParams, id = String(q.get('order_nsu') || '');
      if (Object.hasOwn(PED, id) && PED[id].status === 'pendente' && await checar(PED[id], { transaction_nsu: q.get('transaction_nsu'), slug: q.get('slug') })) { liberar(PED[id], q.get('transaction_nsu')); await persistir(); }
      // volta ao sistema por JS (o cookie Strict nao vai em redirecionamento vindo de outro site)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>Pagamento</title><body style="background:#0f1117;color:#e8ebf2;font:16px system-ui;text-align:center;padding:60px">Pagamento recebido! Voltando ao sistema...<script>location.replace("/?pago=1")</script>');
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
    if (get && u === '/api/vozes') return json(res, 200, fs.readdirSync(D('vozes')).filter(f => AUDIO.test(f)));
    if (get && u === '/api/historico')
      return json(res, 200, fs.readdirSync(D('saidas')).filter(f => f.startsWith(me + '_') && f.endsWith('.mp3')).sort().reverse().slice(0, 50)
        .map(f => ({ arquivo: f, texto: fs.existsSync(D('saidas', f + '.txt')) ? fs.readFileSync(D('saidas', f + '.txt'), 'utf8') : '' })));
    if (get && u.startsWith('/saidas/')) {
      const f = path.basename(u), p = D('saidas', f);
      if (!f.startsWith(me + '_') || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(fs.readFileSync(p));
    }
    if (get && u.startsWith('/vozes/')) {
      const f = path.basename(u), p = D('vozes', f);
      if (!AUDIO.test(f) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      const tipos = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac' };
      const tam = fs.statSync(p).size, rg = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
      const tipo = tipos[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream';
      if (rg) {
        let ini = rg[1] === '' ? tam - (+rg[2] || 0) : +rg[1], fim = rg[1] !== '' && rg[2] !== '' ? +rg[2] : tam - 1;
        ini = Math.max(0, ini); fim = Math.min(fim, tam - 1);
        if (ini > fim) { res.writeHead(416, { 'Content-Range': 'bytes */' + tam }); return res.end(); }
        res.writeHead(206, { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${ini}-${fim}/${tam}`, 'Content-Length': fim - ini + 1 });
        return fs.createReadStream(p, { start: ini, end: fim }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Content-Length': tam });
      return fs.createReadStream(p).pipe(res);
    }
    if (get && u === '/api/pacotes') {
      const modo = !PACOTES.length ? null : (IP_HANDLE && PUBLICO) ? 'auto' : PIX_CHAVE ? 'manual' : null;
      return json(res, 200, { modo, ativo: !!modo, chave: PIX_CHAVE, whatsapp: WHATS, pacotes: PACOTES });
    }
    if (req.method === 'POST' && u === '/api/comprar') {
      if (!(IP_HANDLE && PUBLICO)) return json(res, 400, { erro: 'Pagamento automatico nao configurado' });
      if (!U[me].limite) return json(res, 400, { erro: 'Sua conta nao usa creditos' });
      const abertos = Object.values(PED).filter(x => x.user === me && x.status === 'pendente' && Date.parse(x.criado) > Date.now() - 3600e3).length;
      if (abertos >= 10) return json(res, 429, { erro: 'Muitos pagamentos em aberto. Aguarde um pouco.' });
      const pk = PACOTES[+(await corpo(req, 1e4)).i];
      if (!pk) return json(res, 400, { erro: 'Pacote invalido' });
      const id = crypto.randomUUID(), valor = Math.round(pk.valor * 100);
      const r = await fetch(IP_API + '/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        handle: IP_HANDLE, order_nsu: id, items: [{ quantity: 1, price: valor, description: pk.creditos + ' creditos - IA do Locutor' }],
        redirect_url: PUBLICO + '/pago', webhook_url: PUBLICO + '/webhook-infinitepay' }) });
      const j = await r.json().catch(() => ({})), url = j.url || j.checkout_url || j.link;
      if (!r.ok || !url) return json(res, 502, { erro: 'Nao foi possivel criar o pagamento. Tente novamente.' });
      PED[id] = { id, user: me, creditos: pk.creditos, valor, status: 'pendente', criado: new Date().toISOString() }; salvarP(); await persistir();
      return json(res, 200, { id, url });
    }
    if (get && u === '/api/pedido') {
      const id = String(new URL(req.url, 'http://x').searchParams.get('id') || '');
      if (!Object.hasOwn(PED, id) || PED[id].user !== me) return json(res, 404, { erro: 'Pedido nao encontrado' });
      const p = PED[id];
      if (p.status === 'pendente' && Date.now() - Date.parse(p.criado) < 864e5 && await checar(p)) { liberar(p, ''); await persistir(); }
      return json(res, 200, { status: p.status, creditos: p.creditos });
    }
    if (get && u === '/api/pix') {
      const p = PACOTES[+new URL(req.url, 'http://x').searchParams.get('i')];
      if (!PIX_CHAVE || !p) return json(res, 400, { erro: 'Pacote indisponível' });
      return json(res, 200, { ...p, copiaecola: brcode(p.valor) });
    }
    if (req.method === 'POST' && u === '/api/gerar') return json(res, 200, { arquivo: await gerar(me, await corpo(req)) });
    if (u.startsWith('/api/usuarios')) {
      if (!adm) return json(res, 403, { erro: 'Somente administrador' });
      if (get) return json(res, 200, Object.entries(U).map(([nome, x]) => ({ nome, email: x.email || '', pendente: !!x.pendente, admin: x.admin, limite: x.limite, usados: x.usados })));
      if (req.method === 'POST') { admin(me, await corpo(req)); return json(res, 200, { ok: true }); }
    }
    res.writeHead(404); res.end();
  } catch (e) { json(res, 500, { erro: e.message }); }
});

async function boot() {
  await Promise.all([lojaU.load(), lojaP.load()]);
  let seed = {};
  try { if (fs.existsSync(cachePath)) seed = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  Object.assign(cache, seed);
  if (FB) {
    console.log('Armazenamento: Firestore (projeto ' + FB.project_id + ')');
    const c = await fbGet('config', 'vozes_cache'); if (c) Object.assign(cache, JSON.parse(c));
    else if (Object.keys(cache).length) await salvarCache();
    let sg = await fbGet('config', 'segredo');
    if (!sg) { sg = crypto.randomBytes(32).toString('hex'); await fbSet('config', 'segredo', sg); }
    SEG = sg.trim();
  } else {
    const sp = D('segredo.txt');
    if (!fs.existsSync(sp)) fs.writeFileSync(sp, crypto.randomBytes(32).toString('hex'));
    SEG = fs.readFileSync(sp, 'utf8').trim();
  }
  if (!Object.keys(U).length) {
    if (!SENHA || SENHA.length < 6) { console.error('Primeiro uso: defina SENHA_ACESSO (minimo 6 caracteres). Ela sera a senha do usuario "admin".'); process.exit(1); }
    criar('admin', SENHA, 0, true); await lojaU.flush(); console.log('Usuario "admin" criado com a senha de SENHA_ACESSO.');
  }
  // Redefinicao de emergencia: com RESET_ADMIN=sim no Render, a senha do "admin" volta a ser a de SENHA_ACESSO.
  // Depois de entrar, APAGUE a variavel RESET_ADMIN, senao a senha e redefinida a cada reinicio.
  if (cfg('RESET_ADMIN') === 'sim' && SENHA.length >= 6) {
    if (U.admin) {
      U.admin.salt = crypto.randomBytes(16).toString('hex');
      U.admin.hash = mkhash(SENHA, U.admin.salt);
      U.admin.admin = true; delete U.admin.pendente;
    } else criar('admin', SENHA, 0, true);
    await salvarU(); await lojaU.flush();
    console.log('Senha do admin redefinida a partir de SENHA_ACESSO.');
  }
}
boot().then(() => servidor.listen(PORT, '0.0.0.0', () => console.log('Sistema TTS rodando na porta ' + PORT)))
  .catch(e => { console.error('Falha ao iniciar:', e.message); process.exit(1); });
