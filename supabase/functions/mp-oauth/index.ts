// Conexão da loja com o Mercado Pago (OAuth).
//  ?start=<state>  -> redireciona para a tela de autorização do Mercado Pago (aplicação real ou de teste)
//  ?code=..&state=.. -> retorno do Mercado Pago: troca o código pelas chaves e guarda tudo protegido
const APP = 'https://valeshop-sobradinho.vercel.app/';
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRED = (teste: boolean) => teste
  ? { id: (Deno.env.get('MP_TESTE_CLIENT_ID') || '').trim(), sec: (Deno.env.get('MP_TESTE_CLIENT_SECRET') || '').trim() }
  : { id: (Deno.env.get('MP_CLIENT_ID') || '').trim(), sec: (Deno.env.get('MP_CLIENT_SECRET') || '').trim() };
const RED = SU + '/functions/v1/mp-oauth';
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const volta = (st: string) => new Response(null, { status: 302, headers: { Location: APP + '?mp=' + st + '#/minha' } });
const estado = async (s: string) => { const r = await fetch(SU + '/rest/v1/mp_oauth_estados?state=eq.' + s + '&select=*', { headers: H }); const j = await r.json(); return Array.isArray(j) ? j[0] : null; };

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const st0 = u.searchParams.get('start') || '';
    if (st0) {
      if (!/^[0-9a-f]{64}$/.test(st0)) return volta('erro');
      const e = await estado(st0);
      if (!e || Date.now() - new Date(e.criado_em).getTime() > 30 * 60e3) return volta('expirado');
      const c = CRED(!!e.teste);
      if (!c.id || !c.sec) { console.error('credenciais ausentes', e.teste ? 'teste' : 'real'); return volta('config'); }
      return new Response(null, { status: 302, headers: { Location: 'https://auth.mercadopago.com.br/authorization?client_id=' + c.id + '&response_type=code&platform_id=mp&state=' + st0 + '&redirect_uri=' + encodeURIComponent(RED) } });
    }
    const code = u.searchParams.get('code'), state = u.searchParams.get('state') || '';
    if (u.searchParams.get('error')) return volta('cancelado');
    if (!code || !/^[0-9a-f]{64}$/.test(state)) return volta('erro');
    // consome o state (uso único, validade 30 min)
    const r = await fetch(SU + '/rest/v1/mp_oauth_estados?state=eq.' + state, { method: 'DELETE', headers: { ...H, Prefer: 'return=representation' } });
    const rows = await r.json();
    const e = Array.isArray(rows) && rows[0];
    if (!e || Date.now() - new Date(e.criado_em).getTime() > 30 * 60e3) return volta('expirado');
    const c = CRED(!!e.teste);
    if (!c.id || !c.sec) { console.error('credenciais ausentes'); return volta('config'); }
    const t = await fetch('https://api.mercadopago.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: c.id, client_secret: c.sec, grant_type: 'authorization_code', code, redirect_uri: RED }) });
    const j = await t.json();
    if (!t.ok || !j.access_token) { console.error('token', t.status, j && (j.message || j.error)); return volta('erro'); }
    const agora = new Date().toISOString();
    const row = {
      loja_id: e.loja_id, mp_user_id: j.user_id ?? null, access_token: j.access_token, refresh_token: j.refresh_token ?? null,
      public_key: j.public_key ?? null, live_mode: j.live_mode ?? null, teste: !!e.teste,
      expira_em: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null,
      conectado_em: agora, atualizado_em: agora,
    };
    const w = await fetch(SU + '/rest/v1/mp_contas?on_conflict=loja_id', { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    if (!w.ok) { console.error('salvar', w.status, await w.text()); return volta('erro'); }
    return volta('ok');
  } catch (x) { console.error('falha', String(x)); return volta('erro'); }
});
