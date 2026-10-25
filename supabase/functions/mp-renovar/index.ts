// Renova as chaves das lojas no Mercado Pago antes de vencerem (chamado 1x por dia pelo agendador do banco).
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const CRED = (teste: boolean) => teste
  ? { id: (Deno.env.get('MP_TESTE_CLIENT_ID') || '').trim(), sec: (Deno.env.get('MP_TESTE_CLIENT_SECRET') || '').trim() }
  : { id: (Deno.env.get('MP_CLIENT_ID') || '').trim(), sec: (Deno.env.get('MP_CLIENT_SECRET') || '').trim() };

Deno.serve(async (req) => {
  try {
    const k = req.headers.get('x-notify-key') || '';
    const cfg = await (await fetch(SU + '/rest/v1/app_cfg?chave=eq.notify_key&select=valor', { headers: H })).json();
    if (!k || !cfg[0] || cfg[0].valor !== k) return new Response('forbidden', { status: 403 });
    const lim = new Date(Date.now() + 30 * 864e5).toISOString();
    const L = await (await fetch(SU + '/rest/v1/mp_contas?select=loja_id,refresh_token,teste,expira_em&refresh_token=not.is.null&expira_em=lt.' + encodeURIComponent(lim), { headers: H })).json();
    let ok = 0, falha = 0;
    for (const c of (Array.isArray(L) ? L : [])) {
      const cr = CRED(!!c.teste);
      if (!cr.id || !cr.sec) { falha++; continue; }
      const t = await fetch('https://api.mercadopago.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: cr.id, client_secret: cr.sec, grant_type: 'refresh_token', refresh_token: c.refresh_token }) });
      const j = await t.json().catch(() => ({}));
      if (!t.ok || !j.access_token) { falha++; console.error('renovar', c.loja_id, t.status, j && (j.message || j.error)); continue; }
      const row = { access_token: j.access_token, refresh_token: j.refresh_token ?? c.refresh_token, public_key: j.public_key ?? null,
        expira_em: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null, atualizado_em: new Date().toISOString() };
      const w = await fetch(SU + '/rest/v1/mp_contas?loja_id=eq.' + c.loja_id, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      if (w.ok) ok++; else falha++;
    }
    console.log('renovadas', ok, 'falhas', falha);
    return new Response(JSON.stringify({ ok, falha }), { headers: { 'Content-Type': 'application/json' } });
  } catch (x) { console.error('falha', String(x)); return new Response('erro', { status: 500 }); }
});
