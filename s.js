// Página de compartilhamento: gera a pré-visualização (logo, nome, preço) e leva o cliente ao app.
const API = process.env.GAS_URL || 'https://script.google.com/macros/s/AKfycbwSRneWbjdetaGS9_4kz4ODyQAkFxZxPgMAqGeEAq2Llf3Q5PrREtLbCc6TktQ80vWVGQ/exec';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
module.exports = async (req, res) => {
  const t = req.query.t === 'p' ? 'p' : 'l', id = String(req.query.id || '');
  let title = 'Vitrines do Vale', desc = 'Compre no comércio de Sobradinho e fale direto com a loja pelo WhatsApp.';
  let img = 'https://' + req.headers.host + '/icon-512.png';
  try {
    const d = (await (await fetch(API)).json()).dados;
    if (t === 'p') {
      const p = d.produtos.find(x => x.id === id);
      if (p) { const l = d.lojas.find(x => x.id === p.lojaId) || {}; title = p.titulo + ' - R$ ' + Number(p.preco).toFixed(2).replace('.', ','); desc = 'Na loja ' + (l.nome || '') + '. Peça pelo WhatsApp.'; img = (p.fotos && p.fotos[0]) || l.logo || img; }
    } else {
      const l = d.lojas.find(x => x.id === id);
      if (l) { title = l.nome + ' - Vitrines do Vale'; desc = (l.categoria || 'Loja') + ' em ' + (l.bairro || 'Sobradinho') + '. Veja os produtos e peça pelo WhatsApp.'; img = l.logo || img; }
    }
  } catch (e) {}
  const dest = '/#/' + (t === 'p' ? 'produto' : 'loja') + '/' + encodeURIComponent(id);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>' + esc(title) + '</title><meta property="og:title" content="' + esc(title) + '"><meta property="og:description" content="' + esc(desc) + '"><meta property="og:image" content="' + esc(img) + '"><meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image"><meta http-equiv="refresh" content="0;url=' + esc(dest) + '"></head><body><script>location.replace(' + JSON.stringify(dest) + ')</script></body></html>');
};
