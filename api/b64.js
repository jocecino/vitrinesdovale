// TEMPORÁRIO: baixa ícones Fluent Emoji (MIT) para o repositório. Será removido.
module.exports = async (req, res) => {
  const p = String(req.query.p || '');
  if (!/^[\w\s\-./]+\.png$/.test(p) || p.includes('..')) { res.statusCode = 400; return res.end('x'); }
  const r = await fetch('https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/' + p.split('/').map(encodeURIComponent).join('/'));
  res.setHeader('Content-Type', 'text/plain'); res.setHeader('Cache-Control', 'no-store');
  if (!r.ok) { res.statusCode = r.status; return res.end('erro ' + r.status); }
  res.end(Buffer.from(await r.arrayBuffer()).toString('base64'));
};
