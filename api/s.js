// Página de compartilhamento: gera a pré-visualização (logo, nome, preço) e leva o cliente ao app.
// Cole aqui os mesmos dados do Supabase usados no index.html (a chave "anon public" pode ficar no código).
const SUPA_URL = 'https://kxyqozqnlhfszokboata.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt4eXFvenFubGhmc3pva2JvYXRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2Mzg2MzUsImV4cCI6MjEwODIxNDYzNX0.Wjm-ctswX5KEBZ-vy9i-ez3IYic8Wo6No0wMoqgreeU';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function rpc(f, body) {
  const r = await fetch(SUPA_URL + '/rest/v1/rpc/' + f, { method: 'POST', headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
module.exports = async (req, res) => {
  const t = req.query.t === 'p' ? 'p' : 'l', id = String(req.query.id || '');
  let title = 'ValeShop Sobradinho', desc = 'Compre no comércio de Sobradinho e fale direto com a loja pelo WhatsApp.';
  let img = 'https://' + req.headers.host + '/icon-512.png';
  try {
    if (UUID.test(id)) {
      if (t === 'p') {
        const p = await rpc('get_produto', { p_id: id });
        if (p && p.bloq) { title = 'Produto para maiores de 18 - ValeShop Sobradinho'; desc = 'Conteúdo para maiores de 18 anos. Entre na sua conta para ver.'; }
        else if (p && p.id) {
          const l = (await rpc('get_loja', { p_id: p.lojaId })) || {};
          title = p.titulo + ' - R$ ' + Number(p.oferta ? p.oferta.preco : p.preco).toFixed(2).replace('.', ',');
          desc = 'Na loja ' + (l.nome || '') + '. Peça pelo WhatsApp.';
          img = (p.fotos && p.fotos[0]) || l.logo || img;
        }
      } else {
        const l = await rpc('get_loja', { p_id: id });
        if (l && l.adulta && !l.nome) { title = 'Loja para maiores de 18 - ValeShop Sobradinho'; desc = 'Conteúdo para maiores de 18 anos. Entre na sua conta para ver.'; }
        else if (l && l.id) { title = l.nome + ' - ValeShop Sobradinho'; desc = (l.categoria || 'Loja') + ' em ' + (l.bairro || 'Sobradinho') + '. Veja os produtos e peça pelo WhatsApp.'; img = l.logo || img; }
      }
    }
  } catch (e) {}
  const dest = '/#/' + (t === 'p' ? 'produto' : 'loja') + '/' + encodeURIComponent(id);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>' + esc(title) + '</title><meta property="og:title" content="' + esc(title) + '"><meta property="og:description" content="' + esc(desc) + '"><meta property="og:image" content="' + esc(img) + '"><meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image"><meta http-equiv="refresh" content="0;url=' + esc(dest) + '"></head><body><script>location.replace(' + JSON.stringify(dest) + ')</script></body></html>');
};
