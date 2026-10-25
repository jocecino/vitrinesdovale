// Cria a cobrança (Checkout Pro) na conta da loja, com a comissão do Vale Shop (marketplace_fee).
// Também verifica um pagamento (acao: 'verificar') caso o aviso do Mercado Pago atrase.
const APP = 'https://valeshop-sobradinho.vercel.app/';
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const tel8 = (t: string) => String(t || '').replace(/\D/g, '').slice(-8);
const db = async (path: string) => { const r = await fetch(SU + '/rest/v1/' + path, { headers: H }); return r.ok ? r.json() : []; };
const bahia = (iso: string) => { const d = new Date(new Date(iso).getTime() - 3 * 3600e3); return d.toISOString().replace('Z', '-03:00'); };

async function registrar(n: number, loja: string, p: any) {
  const r = await fetch(SU + '/rest/v1/rpc/mp_pagamento_registrar', { method: 'POST', headers: H,
    body: JSON.stringify({ p_pedido: n, p_loja: loja, p_payment: String(p.id), p_status: String(p.status), p_valor: Number(p.transaction_amount) }) });
  return r.ok ? r.json() : 'erro';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const n = parseInt(b.numero, 10), t = tel8(b.tel);
    if (!n || t.length < 8) return out({ erro: 'Pedido inválido.' }, 400);
    const ped = (await db('pedidos?id=eq.' + n + '&select=*'))[0];
    if (!ped || tel8(ped.tel) !== t) return out({ erro: 'Pedido não encontrado.' }, 404);
    if (ped.pagamento !== 'mp') return out({ erro: 'Este pedido é pago direto com a loja.' }, 400);
    const ct = (await db('mp_contas?loja_id=eq.' + ped.loja_id + '&select=access_token'))[0];
    if (!ct) return out({ erro: 'A loja não está conectada ao Mercado Pago. Fale com a loja.' }, 400);
    const AH = { Authorization: 'Bearer ' + ct.access_token, 'Content-Type': 'application/json' };

    if (b.acao === 'verificar') {
      if (ped.pg_status === 'pago') return out({ status: 'pago' });
      const s = await fetch('https://api.mercadopago.com/v1/payments/search?external_reference=' + n + '&sort=date_created&criteria=desc', { headers: AH });
      const j = await s.json();
      const L = (j && j.results) || [];
      const ap = L.find((x: any) => x.status === 'approved') || L[0];
      if (!ap) return out({ status: ped.pg_status || 'aguardando' });
      const r = await registrar(n, ped.loja_id, ap);
      return out({ status: r === 'pago' || r === 'ja_pago' ? 'pago' : ap.status });
    }

    if (ped.status !== 'confirmado') return out({ erro: ped.status === 'novo' ? 'Aguarde a loja aceitar o pedido.' : 'Este pedido não pode mais ser pago.' }, 400);
    if (ped.pg_status === 'pago') return out({ erro: 'Este pedido já está pago.' }, 400);
    if (ped.pg_status !== 'aguardando' || (ped.pag_ate && new Date(ped.pag_ate).getTime() < Date.now())) return out({ erro: 'O prazo para pagar terminou.' }, 400);
    const total = Math.round(Number(ped.total) * 100) / 100;
    if (!(total > 0)) return out({ erro: 'Valor do pedido inválido.' }, 400);
    const fee = Math.max(0, Math.min(Number(ped.comissao || 0), total - 0.01));
    const lj = (await db('lojas?id=eq.' + ped.loja_id + '&select=nome,parcelas_max'))[0] || {};
    const ids = (ped.itens || []).map((i: any) => i.id).filter(Boolean);
    const pr = ids.length ? await db('produtos?id=in.(' + ids.join(',') + ')&select=id,parcela') : [];
    const inst = pr.some((x: any) => x.parcela === false) ? 1 : Math.max(1, Math.min(12, Number(lj.parcelas_max || 1)));
    const pref: any = {
      items: [{ id: 'pedido-' + n, title: ('Pedido nº ' + n + ' · ' + (lj.nome || 'Vale Shop')).slice(0, 250), quantity: 1, unit_price: total, currency_id: 'BRL' }],
      marketplace_fee: Math.round(fee * 100) / 100,
      external_reference: String(n),
      notification_url: SU + '/functions/v1/mp-webhook?loja=' + ped.loja_id,
      back_urls: { success: APP + '?mppag=ok&n=' + n + '#/pedidos', pending: APP + '?mppag=pend&n=' + n + '#/pedidos', failure: APP + '?mppag=erro&n=' + n + '#/pedidos' },
      auto_return: 'approved',
      payment_methods: { installments: inst },
      statement_descriptor: 'VALESHOP',
      payer: { name: String(ped.cliente || '').slice(0, 60) },
    };
    if (ped.pag_ate) { pref.expires = true; pref.expiration_date_to = bahia(ped.pag_ate); }
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', { method: 'POST', headers: AH, body: JSON.stringify(pref) });
    const j = await r.json();
    if (!r.ok || !j.id) { console.error('pref', r.status, JSON.stringify(j).slice(0, 400)); return out({ erro: 'Não foi possível abrir o pagamento agora. Tente de novo.' }, 502); }
    await fetch(SU + '/rest/v1/pedidos?id=eq.' + n, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ mp_pref_id: String(j.id) }) });
    return out({ url: j.init_point });
  } catch (x) { console.error('falha', String(x)); return out({ erro: 'Erro inesperado. Tente de novo.' }, 500); }
});
