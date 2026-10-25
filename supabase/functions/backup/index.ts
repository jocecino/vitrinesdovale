// Cópia de segurança: estrutura + dados do banco, compactados, no bucket PRIVADO do Cloudflare R2.
// Agendador (x-notify-key) ou administrador (login): acao 'fazer' | 'status' | 'baixar'.
import { AwsClient } from 'npm:aws4fetch@1.0.20';
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const env = (n: string) => (Deno.env.get(n) || '').trim() || (n === 'R2B_BUCKET' ? 'valeshop-backup' : '');
const BASE = 'https://' + env('R2_ACCOUNT_ID') + '.r2.cloudflarestorage.com/' + env('R2B_BUCKET') + '/';
const r2 = new AwsClient({ accessKeyId: env('R2B_ACCESS_KEY_ID'), secretAccessKey: env('R2B_SECRET_ACCESS_KEY'), service: 's3', region: 'auto' });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const rpc = async (f: string) => { const r = await fetch(SU + '/rest/v1/rpc/' + f, { method: 'POST', headers: H, body: '{}' }); if (!r.ok) throw new Error(f + ' ' + r.status + ' ' + (await r.text()).slice(0, 200)); return r.json(); };
const MAX = 8;

async function listar() {
  const r = await r2.fetch(BASE + '?list-type=2&prefix=backups/');
  const x = await r.text();
  if (!r.ok) throw new Error('listar ' + r.status + ' ' + x.slice(0, 200));
  return [...x.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)].map((m) => ({ k: m[1], tam: Number(m[2]) })).sort((a, b) => a.k < b.k ? 1 : -1);
}

async function fazer() {
  const [esq, dados] = await Promise.all([rpc('backup_esquema'), rpc('backup_dados')]);
  const agora = new Date();
  const doc = JSON.stringify({ sistema: 'Vale Shop Sobradinho', gerado_em: agora.toISOString(), formato: 1, esquema_sql: esq, dados });
  const gz = new Uint8Array(await new Response(new Blob([doc]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const dia = new Date(agora.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  const k = 'backups/' + dia + '.json.gz';
  const p = await r2.fetch(BASE + k, { method: 'PUT', body: gz, headers: { 'Content-Type': 'application/gzip' } });
  if (!p.ok) throw new Error('salvar ' + p.status + ' ' + (await p.text()).slice(0, 200));
  const L = await listar();
  for (const o of L.slice(MAX)) await r2.fetch(BASE + o.k, { method: 'DELETE' });
  const info = { arquivo: k, tamanho: gz.length, original: doc.length, em: agora.toISOString(), tabelas: Object.keys(dados).length };
  await fetch(SU + '/rest/v1/app_cfg?on_conflict=chave', { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ chave: 'backup_ultimo', valor: JSON.stringify(info) }) });
  return info;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    let ok = false;
    const k = req.headers.get('x-notify-key') || '';
    if (k) { const cfg = await (await fetch(SU + '/rest/v1/app_cfg?chave=eq.notify_key&select=valor', { headers: H })).json(); ok = !!(cfg[0] && cfg[0].valor === k); }
    if (!ok) {
      const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const ur = await fetch(SU + '/auth/v1/user', { headers: { apikey: SK, Authorization: 'Bearer ' + jwt } });
      const u = ur.ok ? await ur.json() : null;
      if (u && u.id) ok = (await (await fetch(SU + '/rest/v1/admins?user_id=eq.' + u.id + '&select=user_id', { headers: H })).json()).length > 0;
    }
    if (!ok) return out({ erro: 'Sem permissão.' }, 403);
    { const f = ['R2_ACCOUNT_ID', 'R2B_ACCESS_KEY_ID', 'R2B_SECRET_ACCESS_KEY', 'R2B_BUCKET'].filter((n) => !env(n)); if (f.length) return out({ erro: 'Cópia de segurança não configurada. Faltam: ' + f.join(', ') }, 500); }
    const acao = b.acao || 'fazer';
    if (acao === 'status') return out({ copias: await listar() });
    if (acao === 'conferir') {
      const L = await listar(); if (!L[0]) return out({ erro: 'Nenhuma cópia ainda.' }, 404);
      const g = await r2.fetch(BASE + L[0].k); if (!g.ok) return out({ erro: 'ler ' + g.status }, 500);
      const txt = await new Response(g.body!.pipeThrough(new DecompressionStream('gzip'))).text();
      const j = JSON.parse(txt), d = j.dados || {};
      return out({ arquivo: L[0].k, gerado_em: j.gerado_em, sql_kb: Math.round((j.esquema_sql || '').length / 1024), linhas: Object.fromEntries(Object.entries(d).map(([t, v]) => [t, Array.isArray(v) ? v.length : 0])) });
    }
    if (acao === 'baixar') {
      const L = await listar(); const alvo = b.arquivo && L.find((o) => o.k === b.arquivo) || L[0];
      if (!alvo) return out({ erro: 'Nenhuma cópia ainda.' }, 404);
      const s = await r2.sign(new Request(BASE + alvo.k + '?X-Amz-Expires=600'), { aws: { signQuery: true } });
      return out({ url: s.url, arquivo: alvo.k });
    }
    return out({ ok: true, ...(await fazer()) });
  } catch (x) { console.error('backup', String(x)); return out({ erro: String(x).slice(0, 200) }, 500); }
});
