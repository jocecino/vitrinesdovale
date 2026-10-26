// Envia (ou apaga) fotos no Cloudflare R2. Gera a foto principal e a miniatura (-m) já reduzidas no aparelho.
// produtos/logos: lojista dono de loja · banners: administrador · avaliacoes: cliente do pedido (número + WhatsApp).
import { AwsClient } from 'npm:aws4fetch@1.0.20';
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SK, Authorization: 'Bearer ' + SK };
const env = (n: string) => (Deno.env.get(n) || '').trim();
const PUB = env('R2_PUBLIC_URL').replace(/\/$/, '') + '/';
const BASE = 'https://' + env('R2_ACCOUNT_ID') + '.r2.cloudflarestorage.com/' + env('R2_BUCKET') + '/';
const r2 = new AwsClient({ accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY'), service: 's3', region: 'auto' });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const db = async (p: string) => { const r = await fetch(SU + '/rest/v1/' + p, { headers: H }); return r.ok ? r.json() : []; };
const EXT: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
function dec(du: string, max: number) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(du || ''));
  if (!m) return null;
  const bin = atob(m[2]); if (bin.length > max) return null;
  const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return { type: m[1], ext: EXT[m[1]], bytes: u };
}
const put = (k: string, f: { type: string; bytes: Uint8Array }) => r2.fetch(BASE + k, { method: 'PUT', body: f.bytes, headers: { 'Content-Type': f.type, 'Cache-Control': 'public, max-age=31536000, immutable' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const pasta = String(b.pasta || '');
    if (!['produtos', 'logos', 'banners', 'avaliacoes'].includes(pasta)) return out({ erro: 'Pasta inválida.' }, 400);
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    let uid = '';
    if (jwt) { const ur = await fetch(SU + '/auth/v1/user', { headers: { apikey: SK, Authorization: 'Bearer ' + jwt } }); if (ur.ok) { const u = await ur.json(); uid = u && u.id || ''; } }
    let pref = '';
    if (pasta === 'produtos' || pasta === 'logos') {
      if (!uid || !(await db('lojas?owner_id=eq.' + uid + '&select=id')).length) return out({ erro: 'Entre de novo na sua loja.' }, 401);
      pref = pasta + '/' + uid + '/';
    } else if (pasta === 'banners') {
      if (!uid || !(await db('admins?user_id=eq.' + uid + '&select=user_id')).length) return out({ erro: 'Sem permissão.' }, 403);
      pref = 'banners/';
    } else {
      const n = parseInt(b.n, 10), t = String(b.t || '').replace(/\D/g, '').slice(-8);
      const p = n && t.length === 8 ? (await db('pedidos?id=eq.' + n + '&select=tel,status'))[0] : null;
      if (!p || String(p.tel || '').replace(/\D/g, '').slice(-8) !== t || p.status !== 'entregue') return out({ erro: 'Pedido não encontrado.' }, 403);
      pref = 'avaliacoes/' + n + '/';
    }
    if (b.acao === 'apagar') {
      const url = String(b.url || '');
      const adm = uid && (await db('admins?user_id=eq.' + uid + '&select=user_id')).length;
      // fotos migradas do Supabase ficaram em "migr/<pasta>/<dono>/..."
      if (!url.startsWith(PUB + pref) && !url.startsWith(PUB + 'migr/' + pref) && !(adm && url.startsWith(PUB))) return out({ erro: 'Sem permissão.' }, 403);
      const k = url.slice(PUB.length), km = k.replace(/\.(\w+)$/, '-m.$1');
      await r2.fetch(BASE + k, { method: 'DELETE' }); await r2.fetch(BASE + km, { method: 'DELETE' });
      return out({ ok: true });
    }
    const img = dec(b.img, 1_200_000), mini = b.mini ? dec(b.mini, 200_000) : null;
    if (!img) return out({ erro: 'Imagem inválida ou muito grande.' }, 400);
    const nome = pref + Date.now() + '-' + crypto.randomUUID().slice(0, 8);
    const r1 = await put(nome + '.' + img.ext, img);
    if (!r1.ok) { console.error('put', r1.status, (await r1.text()).slice(0, 200)); return out({ erro: 'Falha ao salvar a foto.' }, 502); }
    if (mini) { const r = await put(nome + '-m.' + img.ext, mini.ext === img.ext ? mini : { ...mini }); if (!r.ok) console.error('mini', r.status); }
    return out({ url: PUB + nome + '.' + img.ext });
  } catch (x) { console.error('falha', String(x)); return out({ erro: 'Erro inesperado.' }, 500); }
});
