// Conexão da loja com o Melhor Envio (OAuth), para gerar etiquetas pagas com o saldo da própria loja.
//  ?start=<state>      -> redireciona para a tela de autorização do Melhor Envio
//  ?code=..&state=..   -> retorno: troca o código pelas chaves e guarda tudo protegido (me_contas)
const APP = 'https://eitavale.com.br/';
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ME = 'https://melhorenvio.com.br';
const UA = 'Eita Vale (contato.eitavale@gmail.com)';
const RED = SU + '/functions/v1/me-oauth';
const SCOPES = 'cart-read cart-write orders-read shipping-calculate shipping-cancel shipping-checkout shipping-generate shipping-print shipping-tracking users-read';
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const volta = (st: string) => new Response(null, { status: 302, headers: { Location: APP + '?me=' + st + '#/minha' } });
const cred = () => ({ id: (Deno.env.get('ME_CLIENT_ID') || '').trim(), sec: (Deno.env.get('ME_CLIENT_SECRET') || '').trim() });

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const st0 = u.searchParams.get('start') || '';
    if (st0) {
      if (!/^[0-9a-f]{64}$/.test(st0)) return volta('erro');
      const r = await fetch(SU + '/rest/v1/me_oauth_estados?state=eq.' + st0 + '&select=*', { headers: H });
      const e = (await r.json())[0];
      if (!e || Date.now() - new Date(e.criado_em).getTime() > 30 * 60e3) return volta('expirado');
      const c = cred();
      if (!c.id || !c.sec) { console.error('ME_CLIENT_ID/SECRET ausentes'); return volta('config'); }
      return new Response(null, { status: 302, headers: { Location: ME + '/oauth/authorize?client_id=' + encodeURIComponent(c.id) + '&redirect_uri=' + encodeURIComponent(RED) + '&response_type=code&state=' + st0 + '&scope=' + encodeURIComponent(SCOPES) } });
    }
    if (u.searchParams.get('error')) return volta('cancelado');
    const code = u.searchParams.get('code'), state = u.searchParams.get('state') || '';
    if (!code || !/^[0-9a-f]{64}$/.test(state)) return volta('erro');
    const r = await fetch(SU + '/rest/v1/me_oauth_estados?state=eq.' + state, { method: 'DELETE', headers: { ...H, Prefer: 'return=representation' } });
    const rows = await r.json();
    const e = Array.isArray(rows) && rows[0];
    if (!e || Date.now() - new Date(e.criado_em).getTime() > 30 * 60e3) return volta('expirado');
    const c = cred();
    if (!c.id || !c.sec) return volta('config');
    const t = await fetch(ME + '/oauth/token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: c.id, client_secret: c.sec, redirect_uri: RED, code }) });
    const j = await t.json().catch(() => null);
    if (!t.ok || !j || !j.access_token) { console.error('token', t.status, JSON.stringify(j).slice(0, 300)); return volta('erro'); }
    let nome: string | null = null;
    try {
      const m = await fetch(ME + '/api/v2/me', { headers: { Accept: 'application/json', Authorization: 'Bearer ' + j.access_token, 'User-Agent': UA } });
      const mj = await m.json(); nome = [mj.firstname, mj.lastname].filter(Boolean).join(' ') || mj.email || null;
    } catch (_) { /* opcional */ }
    const agora = new Date().toISOString();
    const row = { loja_id: e.loja_id, access_token: j.access_token, refresh_token: j.refresh_token ?? null, me_nome: nome,
      expira_em: new Date(Date.now() + (Number(j.expires_in) || 2592000) * 1000).toISOString(), conectado_em: agora, atualizado_em: agora };
    const w = await fetch(SU + '/rest/v1/me_contas?on_conflict=loja_id', { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    if (!w.ok) { console.error('salvar', w.status, await w.text()); return volta('erro'); }
    return volta('ok');
  } catch (x) { console.error('falha', String(x)); return volta('erro'); }
});
