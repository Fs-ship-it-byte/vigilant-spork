// Reproduce el caso real: TMDB dice "Perdidos en el Amazonas" / "Lost in the Jungle",
// el sitio lo tiene como "Perdidos en la jungla" (2025) y su buscador es literal.
const assert = require('assert');
const area = require('../areadocumental');

const filas = (items) => items.map(([n, a, g]) => `<div><h2><a href="/player.php?titulo=${n.replace(/ /g, '+')}">${n}</a></h2> &nbsp;&nbsp;&nbsp;${a} &nbsp;&nbsp; ${g} <div class="x"></div></div>`).join('');
const pagina = (items) => `<html><body>${'x'.repeat(500)}${filas(items)}</body></html>`;
const json = (o) => new Response(JSON.stringify(o), { status: 200 });

const peticiones = [];
global.fetch = async (url) => {
  url = String(url);
  peticiones.push(url);
  if (url.includes('/find/')) return json({ movie_results: [{ id: 1 }] });
  if (url.includes('alternative_titles')) return json({ titles: [] });
  if (/themoviedb.*language=en-US/.test(url)) return json({ title: 'Lost in the Jungle', release_date: '2025-05-01', original_title: 'Lost in the Jungle' });
  if (url.includes('themoviedb')) return json({ title: 'Perdidos en el Amazonas', release_date: '2025-05-01' });
  if (url.includes('resultados.php?buscar=perdidos')) return new Response(pagina([['Perdidos en la jungla', '2025', 'Historia'], ['Sudamerica Salvaje: Mundos Perdidos', '2005', 'Naturaleza']]));
  if (url.includes('resultados.php')) return new Response(pagina([])); // el título completo no encuentra nada
  if (url.includes('player.php?titulo=Perdidos+en+la+jungla')) {
    const h = new Headers();
    h.append('set-cookie', 'PHPSESSID=sesion123; path=/');
    return new Response('<script>jwplayer("myElement").setup({ file: "/media/perdidos.mp4" });</script>', { status: 200, headers: h });
  }
  return new Response('', { status: 404 });
};

(async () => {
  const trace = [];
  const r = await area.getStreams('tt32332930', 'movie', null, null, trace);
  console.log(trace.map((t) => '  ' + t).join('\n'));
  assert.strictEqual(r.length, 1, 'debe encontrar la película por palabra clave + año');
  assert.strictEqual(r[0].url, 'https://www.area-documental.com/media/perdidos.mp4');
  assert.strictEqual(r[0].headers.Cookie, 'PHPSESSID=sesion123');
  console.log('  ✓ encuentra "Perdidos en la jungla" a partir de "Perdidos en el Amazonas" (año 2025 coincide)');

  // un título parecido pero de otro año NO debe aceptarse
  global.fetch = ((orig) => async (url) => (String(url).includes('resultados.php?buscar=perdidos') ? new Response(pagina([['Perdidos en la jungla', '1998', 'Historia']])) : orig(url)))(global.fetch);
  const r2 = await area.getStreams('tt32332930', 'movie', null, null, []);
  assert.strictEqual(r2.length, 0);
  console.log('  ✓ mismo nombre parcial pero otro año → se rechaza (sin falsos positivos)');
  console.log('\nPruebas del scraper OK');
})().catch((e) => { console.error('FALLÓ:', e.message); process.exit(1); });
