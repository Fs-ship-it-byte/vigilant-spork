const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const area = require('./areadocumental');
const proxy = require('./proxy');

const PORT = process.env.PORT || 7000;
const ENABLE_DEBUG = process.env.ENABLE_DEBUG === '1';

// ---- configuración obligatoria
{
  const url = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const problemas = [];
  if ((process.env.SIGNING_KEY || '').length < 16) problemas.push('SIGNING_KEY (mínimo 16 caracteres)');
  if (!/^https?:\/\/[^/]+$/.test(url)) problemas.push('PUBLIC_URL (ej. https://mi-addon.onrender.com; en Render se toma de RENDER_EXTERNAL_URL)');
  if (problemas.length) {
    console.error(`Configuración inválida o incompleta: ${problemas.join(', ')}`);
    process.exit(1);
  }
}

const manifest = {
  id: 'org.areadocumental.stremio',
  version: '1.0.0',
  name: 'AreaDocumental',
  description: 'Documentales y series de AreaDocumental en español',
  catalogs: [],
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// ---- resolución con caché y deduplicación (Stremio reintenta si tarda)
const TIEMPO_MAX = 25000;
const cache = new Map(); // clave -> { vence, promesa }

function resolver(type, id, trace) {
  const clave = `${type}:${id}`;
  const previo = cache.get(clave);
  if (previo && previo.vence > Date.now() && !trace) return previo.promesa;

  const [imdb, s, e] = id.split(':');
  const trabajo = Promise.race([
    area.getStreams(imdb, type === 'movie' ? 'movie' : 'tv', s, e, trace),
    new Promise((r) => setTimeout(() => r([]), TIEMPO_MAX))
  ]).catch(() => []);

  const entrada = { vence: Date.now() + 5 * 60 * 1000, promesa: trabajo };
  if (!trace) {
    cache.set(clave, entrada);
    trabajo.then((l) => {
      if (!l.length) entrada.vence = Date.now() + 60 * 1000; // vacíos: reintentar pronto
    });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return trabajo;
}

function aStream(x) {
  return {
    name: x.provider,
    description: `${x.title}\n${x.quality}${x.language ? ` • ${x.language}` : ''}`,
    url: proxy.urlProxy(x.url, x.headers, x.title)
  };
}

builder.defineStreamHandler(async (args) => {
  const lista = await resolver(args.type, args.id);
  return { streams: lista.map(aStream) };
});

// ---- app
const app = express();
app.set('trust proxy', true);
proxy.registrar(app);

app.get('/health', (req, res) => res.send('ok'));

if (ENABLE_DEBUG) {
  // /debug/streams?type=movie&id=tt0111161  |  /debug/streams?type=series&id=tt0903747:1:1
  app.get('/debug/streams', async (req, res) => {
    const t0 = Date.now();
    const trace = [];
    const lista = await resolver(String(req.query.type || 'movie'), String(req.query.id || ''), trace);
    res.json({ ms: Date.now() - t0, trace, crudos: lista, stremio: lista.map(aStream) });
  });
}

app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
  console.log(`AreaDocumental escuchando en el puerto ${PORT}`);
  console.log(`URL pública: ${process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL}`);
  console.log(`Manifest: ${(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '')}/manifest.json`);
});
