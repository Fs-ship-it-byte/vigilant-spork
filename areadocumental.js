// Scraper de AreaDocumental extraído del plugin de Nuvio.
// Sin estado global: seguro para peticiones concurrentes.
// Exporta getStreams(id, tipo, temporada, episodio, trace) -> [{ url, headers, quality, language, provider, title }]
// (Es el mismo formato que usa el plugin de Nuvio, para poder moverlo a Shen sin cambios.)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const TMDB_KEY = process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c';
const FUENTE = 'AreaDocumental';
const BASE = 'https://www.area-documental.com';

// ---------------------------------------------------------------- red
async function pedir(url, { headers, timeout = 10000 } = {}, trace) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: Object.assign({ 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' }, headers || {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout)
    });
    if (trace) trace.push(`GET ${corta(url)} → ${r.status} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return r;
  } catch (e) {
    if (trace) trace.push(`GET ${corta(url)} → error (${e.name}) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return null;
  }
}

async function texto(url, opciones, trace) {
  const r = await pedir(url, opciones, trace);
  if (!r || !r.ok) return '';
  try { return await r.text(); } catch (e) { return ''; }
}

async function json(url, trace) {
  const t = await texto(url, { headers: { Accept: 'application/json' } }, trace);
  try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
}

function corta(url) {
  return String(url).replace(/^https?:\/\/(?:www\.)?/i, '').replace(/api_key=[^&]+/, 'api_key=…').slice(0, 90);
}

function cookies(r) {
  const lista = r && r.headers && typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  return lista.map((c) => c.split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');
}

// ---------------------------------------------------------------- texto
const ENTIDADES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', uuml: 'ü', iexcl: '¡', iquest: '¿' };

function entidades(t) {
  return String(t || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (x, n) => (n in ENTIDADES ? ENTIDADES[n] : x));
}

function limpiarHtml(t) {
  return entidades(String(t || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizar(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' y ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function origen(url) {
  const m = String(url || '').match(/^(https?:\/\/[^/?#]+)/i);
  return m ? m[1] : '';
}

function absoluta(url, base) {
  if (!url) return '';
  const u = entidades(String(url).trim().replace(/\\\//g, '/'));
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return origen(base) + u;
  const b = String(base || '').replace(/[?#].*$/, '');
  return (/^https?:\/\/[^/]+$/i.test(b) ? `${b}/` : b.replace(/[^/]*$/, '')) + u;
}

const RELLENO = new Set(['ver', 'online', 'gratis', 'latino', 'castellano', 'subtitulado', 'espanol', 'audio', 'hd', 'full', 'completa', 'pelicula', 'serie']);
const VACIAS = new Set(['the', 'and', 'of', 'a', 'el', 'la', 'los', 'las', 'de', 'del', 'y', 'en', 'un', 'una']);

function limpiarTitulo(t) {
  const n = normalizar(String(t || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' '));
  const limpio = n.split(' ').filter((p) => !RELLENO.has(p)).join(' ');
  return limpio || n;
}

function parecido(a, b) {
  const x = limpiarTitulo(a);
  const y = limpiarTitulo(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const [corto, largo] = x.length <= y.length ? [x, y] : [y, x];
  const contiene = ` ${largo} `.includes(` ${corto} `) ? 0.6 + (0.4 * corto.length) / largo.length : 0;
  const px = new Set(x.split(' ').filter((p) => !VACIAS.has(p)));
  const py = new Set(y.split(' ').filter((p) => !VACIAS.has(p)));
  let comunes = 0;
  for (const p of px) if (py.has(p)) comunes++;
  const palabras = px.size && py.size ? comunes / Math.max(px.size, py.size) : 0;
  return Math.max(contiene, palabras);
}

function calidadTexto(t) {
  const s = String(t || '');
  if (/2160|4k|uhd/i.test(s)) return '4K';
  const m = s.match(/(1440|1080|720|480|360|240)\s*p?/i);
  return m ? `${m[1]}p` : '';
}

function etiquetaAltura(alto) {
  const h = parseInt(alto, 10) || 0;
  if (!h) return '';
  if (h >= 2000) return '4K';
  if (h >= 1400) return '1440p';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  if (h >= 470) return '480p';
  if (h >= 350) return '360p';
  return `${h}p`;
}

async function calidadHls(url, headers, trace) {
  if (!/m3u8|\/hls|master|playlist|\.txt/i.test(url)) return '';
  const t = await texto(url, { headers, timeout: 5000 }, trace);
  let alto = 0;
  const patron = /RESOLUTION=\d+x(\d+)/gi;
  let m;
  while ((m = patron.exec(t))) alto = Math.max(alto, parseInt(m[1], 10));
  return etiquetaAltura(alto);
}

// ---------------------------------------------------------------- TMDB
async function datosTmdb(id, tipo, trace) {
  let tmdb = String(id || '').trim();
  if (/^tt\d+$/.test(tmdb)) {
    const f = await json(`https://api.themoviedb.org/3/find/${tmdb}?api_key=${TMDB_KEY}&external_source=imdb_id`, trace);
    const r = f && (tipo === 'movie' ? f.movie_results : f.tv_results);
    if (!r || !r[0]) return null;
    tmdb = String(r[0].id);
  }
  const raiz = `https://api.themoviedb.org/3/${tipo}/${tmdb}`;
  const ruta = `${raiz}?api_key=${TMDB_KEY}`;
  const [es, en, ese, alt] = await Promise.all([
    json(`${ruta}&language=es-MX`, trace),
    json(`${ruta}&language=en-US`, trace),
    json(`${ruta}&language=es-ES`, trace),
    json(`${raiz}/alternative_titles?api_key=${TMDB_KEY}`, trace)
  ]);
  if (!es && !en) return null;
  const a = es || {};
  const b = en || {};
  const c = ese || {};
  const paises = new Set(['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'UY', 'EC']);
  const alternos = ((alt && (alt.titles || alt.results)) || []).filter((x) => paises.has(x.iso_3166_1)).map((x) => x.title).slice(0, 4);
  return {
    titulo: a.title || a.name || b.title || b.name || '',
    espana: c.title || c.name || '',
    ingles: b.title || b.name || '',
    original: a.original_title || a.original_name || b.original_title || b.original_name || '',
    alternos,
    anio: String(a.release_date || a.first_air_date || b.release_date || b.first_air_date || '').slice(0, 4)
  };
}

function titulosPosibles(d) {
  const vistos = new Set();
  return [d.titulo, d.espana, ...(d.alternos || []), d.ingles, d.original].filter((t) => {
    const n = normalizar(t);
    if (!n || vistos.has(n)) return false;
    vistos.add(n);
    return true;
  }).slice(0, 5);
}

function encabezado(d, tipo, temporada, episodio) {
  if (tipo === 'tv') return `${d.titulo} - T${temporada} E${episodio}`;
  return d.anio ? `${d.titulo} (${d.anio})` : d.titulo;
}

// ---------------------------------------------------------------- búsqueda en el sitio
function resultados(html) {
  const lista = [];
  const vistos = new Set();
  const patron = /<h[2-4][^>]*>\s*<a[^>]+href=["']([^"']*(?:player\.php\?titulo=|ver\.php\?|\/video\/)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = patron.exec(html))) {
    const url = absoluta(entidades(m[1]), `${BASE}/`);
    if (vistos.has(url)) continue;
    vistos.add(url);
    // el año aparece justo después del título: </h2> &nbsp;&nbsp;2025 &nbsp; Historia
    const cola = entidades(html.slice(patron.lastIndex, patron.lastIndex + 160).replace(/<[^>]+>/g, ' '));
    const anio = (cola.match(/\b((?:19|20)\d{2})\b/) || [])[1] || '';
    lista.push({ nombre: limpiarHtml(m[2]), url, anio });
  }
  return lista;
}

async function buscarTitulo(titulo, trace) {
  const consulta = encodeURIComponent(titulo).replace(/%20/g, '+');
  for (const ruta of [`${BASE}/resultados.php?buscar=${consulta}`, `${BASE}/resultados/buscar=${encodeURIComponent(titulo)}/`]) {
    const html = await texto(ruta, {}, trace);
    const lista = resultados(html);
    if (trace && html) trace.push(`  ↳ ${(html.length / 1024).toFixed(0)}KB, ${lista.length} resultado(s) reconocidos${lista.length ? ': ' + lista.slice(0, 4).map((x) => `${x.nombre}${x.anio ? ` (${x.anio})` : ''}`).join(' | ') : ''}`);
    if (lista.length || html) return lista; // el sitio respondió: no hace falta la ruta alterna
  }
  return [];
}

// El buscador del sitio es literal: "Perdidos en el Amazonas" no encuentra "Perdidos en la jungla".
// Si el título completo no da nada, se buscan sus palabras clave sueltas.
async function candidatos(titulo, trace) {
  const lista = await buscarTitulo(titulo, trace);
  if (lista.length) return lista;
  const palabras = limpiarTitulo(titulo).split(' ').filter((p) => p.length >= 4 && !VACIAS.has(p)).sort((a, b) => b.length - a.length).slice(0, 2);
  const vistos = new Set();
  const todos = [];
  for (const p of palabras) {
    for (const r of await buscarTitulo(p, trace)) {
      if (!vistos.has(r.url)) {
        vistos.add(r.url);
        todos.push(r);
      }
    }
  }
  return todos;
}

function episodioEn(lista, episodio) {
  const ep = lista.find((x) => {
    const r = x.nombre.match(/Ep\w*\.?\s*(\d+)(?:\s*-\s*(\d+))?/i);
    if (!r) return false;
    const desde = Number(r[1]);
    const hasta = Number(r[2] || r[1]);
    return episodio >= desde && episodio <= hasta;
  });
  return ep ? ep.url : null;
}

// Película: acepta coincidencia fuerte (>= 0.8) o, si el año coincide (±1), una parcial (>= 0.5).
function mejorCoincidencia(lista, titulos, tipo, anio) {
  let mejor = null;
  let puntos = 0;
  for (const r of lista) {
    const nombre = r.nombre.replace(/\s*Ep\w*\.?\s*\d+.*$/i, '');
    for (const t of titulos) {
      let s = parecido(nombre, t);
      const mismoAnio = tipo === 'movie' && anio && r.anio && Math.abs(Number(r.anio) - Number(anio)) <= 1;
      if (mismoAnio && s >= 0.5) s = Math.max(s, 0.8); // año + parecido razonable
      if (s > puntos) {
        puntos = s;
        mejor = r;
      }
    }
  }
  return { mejor, puntos };
}

async function buscar(titulos, tipo, episodio, anio, trace) {
  for (const titulo of titulos) {
    if (tipo === 'tv') {
      const directo = episodioEn(resultados(await texto(`${BASE}/resultados-serie.php?buscar=${encodeURIComponent(titulo)}&genero=`, {}, trace)), episodio);
      if (directo) return directo;
    }
    const lista = await candidatos(titulo, trace);
    const { mejor, puntos } = mejorCoincidencia(lista, titulos, tipo, anio);
    if (trace) trace.push(`  ↳ mejor coincidencia con "${titulo}": ${mejor ? `${mejor.nombre}${mejor.anio ? ` (${mejor.anio})` : ''}` : 'ninguna'} (puntaje ${puntos.toFixed(2)}, mínimo 0.80)`);
    if (!mejor || puntos < 0.8) continue;
    if (tipo === 'movie') return mejor.url;
    const ficha = await texto(mejor.url, {}, trace);
    const serie = ficha.match(/href=["']([^"']*resultados-serie\.php\?buscar=([^"'&]+)[^"']*)["']/);
    if (!serie) continue;
    const ep = episodioEn(resultados(await texto(`${BASE}/resultados-serie.php?buscar=${encodeURIComponent(decodeURIComponent(serie[2]))}&genero=`, {}, trace)), episodio);
    if (ep) return ep;
  }
  return null;
}

// ---------------------------------------------------------------- API pública
async function getStreams(id, mediaType, season, episode, trace) {
  try {
    const tipo = mediaType === 'movie' ? 'movie' : 'tv';
    const datos = await datosTmdb(id, tipo, trace);
    if (!datos) {
      if (trace) trace.push('TMDB: sin datos');
      return [];
    }
    const temporada = Number(season) || 1;
    const ep = Number(episode) || 1;
    const titulos = titulosPosibles(datos);
    if (trace) trace.push(`títulos: ${JSON.stringify(titulos)}`);
    const pagina = await buscar(titulos, tipo, ep, datos.anio, trace);
    if (!pagina) {
      if (trace) trace.push('sin coincidencia en el sitio');
      return [];
    }
    if (trace) trace.push(`página: ${pagina}`);
    const r = await pedir(pagina, {}, trace);
    if (!r || !r.ok) return [];
    const html = (await r.text()) || '';
    const sesion = (cookies(r).match(/PHPSESSID=[^;]+/) || [])[0];
    const configuracion = (html.match(/jwplayer\(['"]myElement['"]\)\.setup\(([\s\S]*?)\);/) || [])[1] || html;
    const video = (configuracion.match(/file:\s*"([^"]+\.(?:mp4|m3u8)[^"]*)"/) || configuracion.match(/file:\s*"([^"]+)"/) || [])[1];
    if (!video) {
      if (trace) trace.push('sin enlace de video en la página');
      return [];
    }
    const nombre = (pagina.match(/titulo=([^&]+)/) || pagina.match(/\/video\/([^/?#]+)/) || [])[1] || '';
    const headers = { Referer: `${BASE}/video/${nombre}/`, 'User-Agent': UA };
    if (sesion) headers.Cookie = sesion;
    const url = absoluta(video, BASE);
    const calidad = (await calidadHls(url, headers, trace)) || calidadTexto(url) || '720p';
    if (trace) trace.push(`video: ${corta(url)} · ${calidad} · cookie=${sesion ? 'sí' : 'no'}`);
    return [{ url, headers, quality: calidad, language: 'Español', provider: FUENTE, title: encabezado(datos, tipo, temporada, ep) }];
  } catch (e) {
    console.log(`[${FUENTE}] ${e.message}`);
    if (trace) trace.push(`excepción: ${e.message}`);
    return [];
  }
}

async function diagnosticoBusqueda(q) {
  const trace = [];
  const url = `${BASE}/resultados.php?buscar=${encodeURIComponent(q).replace(/%20/g, '+')}`;
  const r = await pedir(url, {}, trace);
  const html = r && r.ok ? await r.text() : '';
  return {
    status: r ? r.status : 0,
    bytes: html.length,
    reconocidos: resultados(html).slice(0, 15),
    enlaces: (html.match(/href=["'][^"']*(?:player|ver\.php|video|serie)[^"']*["']/gi) || []).slice(0, 15),
    encabezados: (html.match(/<h[1-4][^>]*>[\s\S]{0,160}/gi) || []).slice(0, 8).map((x) => x.replace(/\s+/g, ' ')),
    muestra: limpiarHtml(html.slice(0, 4000)).slice(0, 400),
    trace
  };
}

module.exports = { getStreams, diagnosticoBusqueda, FUENTE };
