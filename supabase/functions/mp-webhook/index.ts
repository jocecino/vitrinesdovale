// Recebe o aviso do Mercado Pago e confere o pagamento direto na API (com a chave da loja) antes de marcar como pago.
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const ok = () => new Response('ok', { status: 200 });

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url), loja = u.searchParams.get('loja') || '';
    const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const tipo = b.type || b.topic || u.searchParams.get('type') || u.searchParams.get('topic') || '';
    const id = String((b.data && b.data.id) || u.searchParams.get('data.id') || u.searchParams.get('id') || '');
    if (tipo !== 'payment' || !/^\d+$/.test(id) || !/^[0-9a-f-]{36}$/.test(loja)) return ok();
    const cr = await fetch(SU + '/rest/v1/mp_contas?loja_id=eq.' + loja + '&select=access_token', { headers: H });
    const ct = (await cr.json())[0];
    if (!ct) return ok();
    const r = await fetch('https://api.mercadopago.com/v1/payments/' + id, { headers: { Authorization: 'Bearer ' + ct.access_token } });
    if (!r.ok) { console.error('payment', r.status); return ok(); }
    const p = await r.json();
    const n = parseInt(p.external_reference, 10);
    if (!n) return ok();
    const g = await fetch(SU + '/rest/v1/rpc/mp_pagamento_registrar', { method: 'POST', headers: H,
      body: JSON.stringify({ p_pedido: n, p_loja: loja, p_payment: String(p.id), p_status: String(p.status), p_valor: Number(p.transaction_amount) }) });
    console.log('pedido', n, p.status, await g.text());
    return ok();
  } catch (x) { console.error('falha', String(x)); return ok(); }
});
