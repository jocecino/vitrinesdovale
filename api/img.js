// Proxy das fotos dos produtos (mesmo domínio): permite montar a arte do Status e o cartaz no navegador (canvas).
const OK = /^https:\/\/(fotos\.eitavale\.com\.br|pub-c1cbf15f15c14757a0192ce3ea39d547\.r2\.dev)\/[A-Za-z0-9_\-./%]+$/;
module.exports = async (req, res) => {
  const u = String(req.query.u || '');
  if (!OK.test(u) || u.includes('..')) { res.statusCode = 400; return res.end(''); }
  try {
    const r = await fetch(u);
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\//.test(ct)) { res.statusCode = 404; return res.end(''); }
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > 8e6) { res.statusCode = 413; return res.end(''); }
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    res.end(b);
  } catch (e) { res.statusCode = 502; res.end(''); }
};
