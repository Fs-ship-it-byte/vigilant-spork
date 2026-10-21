// Proxy propio: sustituye al gateway/Worker de Cloudflare.
//   /p/:token/index.m3u8  → playlist HLS reescrita (sub-playlists por aquí)
//   /s/:token/seg         → segmento / llave por proxy (con soporte Range)
//   /f/:token/video.mp4   → archivo directo (mp4) con soporte Range (adelantar/retroceder)
// Tokens firmados con HMAC (mismo esquema que Shen: base64url(JSON).firma), caducan a las 12 h.
// Solo se puede proxear lo que el propio servidor firmó, y nunca IPs privadas (anti-SSRF).

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { Readable } = require('stream');

const TTL = 12 * 3600;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1'; // solo para pruebas locales
const key = () => process.env.SIGNING_KEY || '';
const baseUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

// ------------------------------------------------------------ tokens
function firmar(body) {
  return crypto.createHmac('sha256', key()).update(body).digest('base64url');
}

function codificar(url, headers, title) {
  const p = { url, headers: headers || {}, exp: Math.floor(Date.now() / 1000) + TTL };
  if (title) p.title = String(title).slice(0, 100);
  const body = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
  return `${body}.${firmar(body)}`;
}

function decodificar(token) {
  try {
    const t = String(token);
    const i = t.lastIndexOf('.');
    if (i < 1) return null;
    const body = t.slice(0, i);
    const dado = Buffer.from(t.slice(i + 1));
    const esperado = Buffer.from(firmar(body));
    if (dado.length !== esperado.length || !crypto.timingSafeEqual(dado, esperado)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p.url !== 'string' || typeof p.exp !== 'number' || p.exp < Date.now() / 1000) return null;
    return p;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------ anti-SSRF
function ipPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::' || x.startsWith('fe80') || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('ff')) return true;
    const m4 = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m4) return ipPrivada(m4[1]);
    const mh = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mh) {
      const hi = parseInt(mh[1], 16);
      const lo = parseInt(mh[2], 16);
      return ipPrivada(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return false;
  }
  return true;
}

async function verificarDestino(raw) {
  if (ALLOW_PRIVATE) return;
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('URL inválida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Protocolo no permitido');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Destino no permitido');
  if (net.isIP(host)) {
    if (ipPrivada(host)) throw new Error('Destino no permitido');
    return;
  }
  const dirs = await dns.promises.lookup(host, { all: true });
  if (!dirs.length || dirs.some((d) => ipPrivada(d.address))) throw new Error('Destino no permitido');
}

// fetch con redirects manuales: cada salto se revisa
async function traerSeguro(url, headers, signal) {
  let actual = url;
  const h = Object.assign({}, headers);
  for (let i = 0; i <= 3; i++) {
    await verificarDestino(actual);
    const r = await fetch(actual, { headers: h, redirect: 'manual', signal });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      const siguiente = new URL(loc, actual).href;
      if (new URL(siguiente).origin !== new URL(actual).origin) delete h.Cookie; // no filtrar la cookie a otro dominio
      actual = siguiente;
      if (r.body && r.body.cancel) r.body.cancel().catch(() => {});
      continue;
    }
    return { res: r, url: actual };
  }
  throw new Error('Demasiadas redirecciones');
}

// ------------------------------------------------------------ URLs que se entregan a Stremio
const esLista = (u) => /\.(m3u8|txt)(\?|#|$)/i.test(u);

function urlProxy(destino, headers, title) {
  const base = baseUrl();
  const token = codificar(destino, headers, title);
  return esLista(destino) ? `${base}/p/${token}/index.m3u8` : `${base}/f/${token}/video.mp4`;
}

// ------------------------------------------------------------ reescritura de playlists
const HOSTS_PUBLICOS = [/(^|\.)tiktokcdn\.com$/i, /(^|\.)doubleclick\.net$/i, /(^|\.)googlesyndication\.com$/i];
const hostPublico = (u) => { try { return HOSTS_PUBLICOS.some((rx) => rx.test(new URL(u).hostname)); } catch (e) { return false; } };

function segmentosPorProxy(headers) {
  if (process.env.SEG_PROXY === '1') return true;
  if (process.env.SEG_PROXY === '0') return false;
  return !!(headers && headers.Cookie); // auto: si el sitio exige cookie, los segmentos no pueden ir directos
}

function reescribir(texto, base, headers, title) {
  const porProxy = segmentosPorProxy(headers);
  const tok = (u) => codificar(u, headers, title);
  const lista = (u) => `${baseUrl()}/p/${tok(u)}/index.m3u8`;
  const seg = (u, forzar) => (forzar || (porProxy && !hostPublico(u)) ? `${baseUrl()}/s/${tok(u)}/seg` : u);
  const abs = (u) => new URL(u, base).href;
  let siguienteEsLista = false;
  return texto.split(/\r?\n/).map((linea) => {
    const l = linea.trim();
    if (!l) return linea;
    if (l.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF/i.test(l)) siguienteEsLista = true;
      return linea.replace(/URI="([^"]+)"/g, (_, u) => {
        const a = abs(u);
        if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/i.test(l)) return `URI="${lista(a)}"`;
        if (/^#EXT-X-(SESSION-)?KEY/i.test(l)) return `URI="${seg(a, true)}"`;
        return `URI="${seg(a)}"`;
      });
    }
    const a = abs(l);
    const r = siguienteEsLista || esLista(a) ? lista(a) : seg(a);
    siguienteEsLista = false;
    return r;
  }).join('\n');
}

// ------------------------------------------------------------ manejadores
async function manejarLista(req, res) {
  const d = decodificar(req.params.token);
  if (!d) return res.status(400).send('Token inválido');
  try {
    const { res: up, url } = await traerSeguro(d.url, d.headers, AbortSignal.timeout(15000));
    if (!up.ok) return res.status(502).send(`Origen respondió ${up.status}`);
    const t = await up.text();
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(reescribir(t, url, d.headers, d.title));
  } catch (e) {
    console.log('Playlist no disponible:', e.message);
    res.status(502).send('No se pudo obtener el playlist');
  }
}

async function manejarArchivo(req, res) {
  const d = decodificar(req.params.token);
  if (!d) return res.status(400).send('Token inválido');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = Object.assign({}, d.headers);
  if (req.headers.range) headers.Range = req.headers.range;
  try {
    const { res: up } = await traerSeguro(d.url, headers, ac.signal);
    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
      const v = up.headers.get(h);
      if (v) res.set(h, v);
    }
    res.set('Access-Control-Allow-Origin', '*');
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).send('No se pudo obtener el archivo');
    else res.destroy();
  }
}

function registrar(app) {
  app.get('/p/:token/*', manejarLista);
  app.get('/s/:token/*', manejarArchivo);
  app.get('/f/:token/*', manejarArchivo);
}

module.exports = { registrar, urlProxy, reescribir, codificar, decodificar, esLista };
