// Prueba local del proxy con un "origen" falso. No necesita internet.
process.env.ALLOW_PRIVATE = '1';
process.env.SIGNING_KEY = 'clave-de-prueba-1234567890';
const http = require('http');
const assert = require('assert');
const express = require('express');

const VIDEO = Buffer.alloc(1024 * 1024, 7);
const origen = http.createServer((req, res) => {
  if (req.headers.cookie !== 'PHPSESSID=abc' || req.headers.referer !== 'https://sitio/') { res.writeHead(403); return res.end('prohibido'); }
  if (req.url === '/video.mp4') {
    const r = req.headers.range && req.headers.range.match(/bytes=(\d+)-(\d*)/);
    if (r) {
      const a = +r[1], b = r[2] ? +r[2] : VIDEO.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/${VIDEO.length}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
      return res.end(VIDEO.subarray(a, b + 1));
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': VIDEO.length, 'Accept-Ranges': 'bytes' });
    return res.end(VIDEO);
  }
  if (req.url === '/hls/master.m3u8') { res.writeHead(200); return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nmedia/index.m3u8\n'); }
  if (req.url === '/hls/media/index.m3u8') { res.writeHead(200); return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nseg2.ts\n#EXT-X-ENDLIST\n'); }
  if (req.url === '/hls/media/seg1.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end('SEGMENTO1'); }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => origen.listen(0, '127.0.0.1', r));
  const po = origen.address().port;
  const app = express();
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const pp = srv.address().port;
  process.env.PUBLIC_URL = `http://127.0.0.1:${pp}`;
  const proxy = require('../proxy');
  proxy.registrar(app);
  const H = { Cookie: 'PHPSESSID=abc', Referer: 'https://sitio/' };
  const ok = (n) => console.log(`  ✓ ${n}`);

  // 1) mp4 completo
  let u = proxy.urlProxy(`http://127.0.0.1:${po}/video.mp4`, H, 'x');
  assert(u.includes('/f/'));
  let r = await fetch(u);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.arrayBuffer()).byteLength, VIDEO.length);
  ok('mp4 completo, con Cookie y Referer reenviados');

  // 2) Range (adelantar/retroceder)
  r = await fetch(u, { headers: { Range: 'bytes=1000-1999' } });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), `bytes 1000-1999/${VIDEO.length}`);
  assert.strictEqual((await r.arrayBuffer()).byteLength, 1000);
  ok('Range → 206 con Content-Range correcto');

  // 3) token manipulado / sin firma
  const malo = u.replace('/f/', '/f/AAAA');
  assert.strictEqual((await fetch(malo)).status, 400);
  ok('token manipulado rechazado');

  // 4) HLS: master → media → segmento
  u = proxy.urlProxy(`http://127.0.0.1:${po}/hls/master.m3u8`, H, 'x');
  assert(u.includes('/p/'));
  const master = await (await fetch(u)).text();
  const sub = master.split('\n').find((l) => l.startsWith('http'));
  assert(sub && sub.includes('/p/'), 'la sub-playlist debe ir por el proxy');
  ok('master reescrita: sub-playlist por el proxy');
  const media = await (await fetch(sub)).text();
  const segs = media.split('\n').filter((l) => l.startsWith('http') && l.includes('/s/'));
  assert(segs.length >= 2, 'con Cookie los segmentos van por proxy (modo auto)');
  assert(/URI="http[^"]+\/s\//.test(media), 'la llave AES va por proxy');
  ok('media reescrita: segmentos y llave por proxy (auto por Cookie)');
  r = await fetch(segs[0]);
  assert.strictEqual(await r.text(), 'SEGMENTO1');
  ok('segmento servido a través del proxy');

  // 5) sin Cookie → segmentos directos
  const directo = proxy.reescribir('#EXTM3U\n#EXTINF:4,\nseg1.ts\n', `http://127.0.0.1:${po}/hls/media/index.m3u8`, { Referer: 'x' }, 't');
  assert(directo.includes(`http://127.0.0.1:${po}/hls/media/seg1.ts`));
  ok('sin Cookie: segmentos directos al CDN (no gasta banda)');

  // 6) anti-SSRF (se desactiva ALLOW_PRIVATE solo para esta comprobación)
  process.env.ALLOW_PRIVATE = '0';
  delete require.cache[require.resolve('../proxy')];
  const estricto = require('../proxy');
  const app2 = express(); estricto.registrar(app2);
  const s2 = http.createServer(app2); await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  process.env.PUBLIC_URL = `http://127.0.0.1:${s2.address().port}`;
  r = await fetch(estricto.urlProxy('http://127.0.0.1:9/secreto.mp4', H, 'x'));
  assert.strictEqual(r.status, 502);
  r = await fetch(estricto.urlProxy('http://169.254.169.254/latest/meta-data', H, 'x'));
  assert.strictEqual(r.status, 502);
  ok('SSRF: localhost y metadata de cloud bloqueados');

  console.log('\nTodas las pruebas pasaron');
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
