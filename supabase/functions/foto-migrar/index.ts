// Migração única: copia as fotos do Supabase Storage para o Cloudflare R2 (com miniatura) e troca os links no banco.
// Processa poucas fotos por chamada. Protegido pela notify_key.
import { AwsClient } from 'npm:aws4fetch@1.0.20';
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const env = (n: string) => (Deno.env.get(n) || '').trim();
const PUB = env('R2_PUBLIC_URL').replace(/\/$/, '') + '/';
const BASE = 'https://' + env('R2_ACCOUNT_ID') + '.r2.cloudflarestorage.com/' + env('R2_BUCKET') + '/';
const r2 = new AwsClient({ accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY'), service: 's3', region: 'auto' });
const rpc = async (f: string, a: unknown) => { const r = await fetch(SU + '/rest/v1/rpc/' + f, { method: 'POST', headers: H, body: JSON.stringify(a) }); return r.json(); };

Deno.serve(async (req) => {
  const k = req.headers.get('x-notify-key') || '';
  const cfg = await (await fetch(SU + '/rest/v1/app_cfg?chave=eq.notify_key&select=valor', { headers: H })).json();
  if (!k || !cfg[0] || cfg[0].valor !== k) return new Response('forbidden', { status: 403 });
  const lim = Math.min(4, Number(new URL(req.url).searchParams.get('n') || 2));
  const L: string[] = await rpc('foto_urls', { p_lim: lim });
  const res: unknown[] = [];
  for (const u of L) {
    try {
      const g = await fetch(u); if (!g.ok) { res.push({ u, erro: 'baixar ' + g.status }); continue; }
      const buf = new Uint8Array(await g.arrayBuffer());
      const tipo = g.headers.get('content-type') || 'image/jpeg';
      const ext = /png/.test(tipo) ? 'png' : /webp/.test(tipo) ? 'webp' : 'jpg';
      const m = /\/object\/public\/([^/]+)\/(.+)$/.exec(u)!;
      const nome = 'migr/' + m[1] + '/' + m[2].replace(/\.[^.\/]+$/, '').replace(/[^\w\/-]/g, '_');
      const p1 = await r2.fetch(BASE + nome + '.' + ext, { method: 'PUT', body: buf, headers: { 'Content-Type': tipo, 'Cache-Control': 'public, max-age=31536000, immutable' } });
      if (!p1.ok) { res.push({ u, erro: 'r2 ' + p1.status }); continue; }
      let mini = false;
      try {
        if (m[1] !== 'banners') {
          const im = await Image.decode(buf);
          if (im.width > 420) im.resize(420, Image.RESIZE_AUTO);
          const jb = await im.encodeJPEG(72);
          const p2 = await r2.fetch(BASE + nome + '-m.' + ext, { method: 'PUT', body: jb, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
          mini = p2.ok;
        }
      } catch (e) { console.error('mini', String(e).slice(0, 120)); }
      if (!mini && m[1] !== 'banners') { await r2.fetch(BASE + nome + '-m.' + ext, { method: 'PUT', body: buf, headers: { 'Content-Type': tipo, 'Cache-Control': 'public, max-age=31536000, immutable' } }); }
      const n = await rpc('foto_trocar', { p_old: u, p_new: PUB + nome + '.' + ext });
      res.push({ u: m[2], ok: true, mini, linhas: n });
    } catch (e) { res.push({ u, erro: String(e).slice(0, 120) }); }
  }
  const resta: string[] = await rpc('foto_urls', { p_lim: 1000 });
  return Response.json({ feitas: res, restam: Array.isArray(resta) ? resta.length : -1 });
});
