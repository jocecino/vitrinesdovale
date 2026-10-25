// Recebe o retorno da autorização do Mercado Pago (OAuth) e guarda as chaves da loja.
const APP = 'https://valeshop-sobradinho.vercel.app/';
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CID = (Deno.env.get('MP_CLIENT_ID') || '').trim(), CSEC = (Deno.env.get('MP_CLIENT_SECRET') || '').trim();
const RED = SU + '/functions/v1/mp-oauth';
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const volta = (st: string) => new Response(null, { status: 302, headers: { Location: APP + '?mp=' + st + '#/minha' } });

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url), code = u.searchParams.get('code'), state = u.searchParams.get('state') || '';
    if (u.searchParams.get('error')) return volta('cancelado');
    if (!code || !/^[0-9a-f]{64}$/.test(state)) return volta('erro');
    if (!CID || !CSEC) { console.error('MP_CLIENT_ID/MP_CLIENT_SECRET ausentes'); return volta('config'); }
    // consome o state (uso único, validade 30 min)
    const r = await fetch(SU + '/rest/v1/mp_oauth_estados?state=eq.' + state, { method: 'DELETE', headers: { ...H, Prefer: 'return=representation' } });
    const rows = await r.json();
    const e = Array.isArray(rows) && rows[0];
    if (!e || Date.now() - new Date(e.criado_em).getTime() > 30 * 60e3) return volta('expirado');
    const body: Record<string, string> = { client_id: CID, client_secret: CSEC, grant_type: 'authorization_code', code, redirect_uri: RED };
    if (e.teste) body.test_token = 'true';
    const t = await fetch('https://api.mercadopago.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const j = await t.json();
    if (!t.ok || !j.access_token) { console.error('token', t.status, j && (j.message || j.error)); return volta('erro'); }
    const row = {
      loja_id: e.loja_id, mp_user_id: j.user_id ?? null, access_token: j.access_token, refresh_token: j.refresh_token ?? null,
      public_key: j.public_key ?? null, live_mode: j.live_mode ?? null,
      expira_em: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null,
      conectado_em: new Date().toISOString(), atualizado_em: new Date().toISOString(),
    };
    const w = await fetch(SU + '/rest/v1/mp_contas?on_conflict=loja_id', { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    if (!w.ok) { console.error('salvar', w.status, await w.text()); return volta('erro'); }
    return volta('ok');
  } catch (x) { console.error('falha', String(x)); return volta('erro'); }
});
