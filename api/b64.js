// TEMPORÁRIO: baixa ícones Fluent Emoji (MIT) para o repositório. Será removido.
module.exports = async (req, res) => {
  const ps = String(req.query.p || '').split('|').filter(Boolean).slice(0, 30);
  const out = {};
  for (const p of ps) {
    if (!/^[\w\s\-./]+\.png$/.test(p) || p.includes('..')) { out[p] = 'invalido'; continue; }
    const r = await fetch('https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/' + p.split('/').map(encodeURIComponent).join('/'));
    out[p] = r.ok ? Buffer.from(await r.arrayBuffer()).toString('base64') : 'erro ' + r.status;
  }
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out));
};
