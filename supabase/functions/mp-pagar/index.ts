// Cria a cobrança (Checkout Pro) na conta da loja, com a comissão do Eita Vale (marketplace_fee).
// Também verifica um pagamento (acao: 'verificar') caso o aviso do Mercado Pago atrase.
// Pedido em 2 partes (sinal): a 1ª cobrança é o sinal; com parte: 'restante', cobra o restante + frete quando a loja marca Pronto.
const APP = 'https://eitavale.com.br/';
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const tel8 = (t: string) => String(t || '').replace(/\D/g, '').slice(-8);
const db = async (path: string) => { const r = await fetch(SU + '/rest/v1/' + path, { headers: H }); return r.ok ? r.json() : []; };
const bahia = (iso: string) => { const d = new Date(new Date(iso).getTime() - 3 * 3600e3); return d.toISOString().replace('Z', '-03:00'); };

async function registrar(n: number, loja: string, p: any, rest = false) {
  const r = await fetch(SU + '/rest/v1/rpc/' + (rest ? 'mp_restante_registrar' : 'mp_pagamento_registrar'), { method: 'POST', headers: H,
    body: JSON.stringify({ p_pedido: n, p_loja: loja, p_payment: String(p.id), p_status: String(p.status), p_valor: Number(p.transaction_amount) }) });
  if (p.status === 'approved' && !rest) await fetch(SU + '/rest/v1/pedidos?id=eq.' + n + '&loja_id=eq.' + loja, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ mp_tipo: String(p.payment_type_id || ''), mp_parcelas: Number(p.installments || 1) }) });
  return r.ok ? r.json() : 'erro';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const n = parseInt(b.numero, 10), t = tel8(b.tel);
    if (!n || t.length < 8) return out({ erro: 'Pedido inválido.' }, 400);
    let ped = (await db('pedidos?id=eq.' + n + '&select=*,v_sinal:pv_sinal,c_sinal:pv_sinal_com,v_rest:pv_rest,c_rest:pv_rest_com'))[0];
    if (!ped) { // reserva: calcula aqui os valores do sinal (mesma regra do banco)
      ped = (await db('pedidos?id=eq.' + n + '&select=*'))[0];
      if (ped && ped.sinal_pct != null) {
        const r2 = (x: number) => Math.round(x * 100) / 100, pc = Number(ped.sinal_pct);
        ped.v_sinal = ped.sinal_valor != null ? Number(ped.sinal_valor) : Math.max(0.01, r2((Number(ped.total) - Number(ped.frete || 0)) * pc / 100));
        ped.c_sinal = ped.sinal_com != null ? Number(ped.sinal_com) : r2(Number(ped.comissao || 0) * pc / 100);
        ped.v_rest = Math.max(0, r2(Number(ped.total) - ped.v_sinal)); ped.c_rest = Math.max(0, r2(Number(ped.comissao || 0) - ped.c_sinal));
      }
    }
    const rest = b.parte === 'restante';
    if (!ped || tel8(ped.tel) !== t) return out({ erro: 'Pedido não encontrado.' }, 404);
    if (ped.pagamento !== 'mp') return out({ erro: 'Este pedido é pago direto com a loja.' }, 400);
    const ct = (await db('mp_contas?loja_id=eq.' + ped.loja_id + '&select=access_token'))[0];
    if (!ct) return out({ erro: 'A loja não está conectada ao Mercado Pago. Fale com a loja.' }, 400);
    const AH = { Authorization: 'Bearer ' + ct.access_token, 'Content-Type': 'application/json' };

    if (b.acao === 'verificar') {
      if (rest ? ped.rest_status === 'pago' : ped.pg_status === 'pago') return out({ status: 'pago' });
      const s = await fetch('https://api.mercadopago.com/v1/payments/search?external_reference=' + n + (rest ? '-r' : '') + '&sort=date_created&criteria=desc', { headers: AH });
      const j = await s.json();
      const L = (j && j.results) || [];
      const ap = L.find((x: any) => x.status === 'approved') || L[0];
      if (!ap) return out({ status: (rest ? ped.rest_status : ped.pg_status) || 'aguardando' });
      const r = await registrar(n, ped.loja_id, ap, rest);
      return out({ status: r === 'pago' || r === 'ja_pago' ? 'pago' : ap.status });
    }

    // restante do pedido em 2 partes: cobrado quando a loja marca Pronto
    if (rest) {
      if (ped.sinal_pct == null || ped.pg_status !== 'pago' || ped.status !== 'confirmado') return out({ erro: 'Este pedido não tem restante para pagar.' }, 400);
      if (ped.rest_status === 'pago') return out({ erro: 'O restante já está pago.' }, 400);
      if (ped.rest_status !== 'aguardando') return out({ erro: 'Aguarde a loja avisar que ficou pronto.' }, 400);
      if (ped.rest_ate && new Date(ped.rest_ate).getTime() < Date.now()) return out({ erro: 'O prazo para pagar o restante terminou.' }, 400);
      const vr = Math.round(Number(ped.v_rest) * 100) / 100;
      if (!(vr > 0)) return out({ erro: 'Valor do restante inválido.' }, 400);
      const fr = Math.max(0, Math.min(Number(ped.c_rest || 0), vr - 0.01));
      const lj0 = (await db('lojas?id=eq.' + ped.loja_id + '&select=nome,parcelas_max'))[0] || {};
      const pr2: any = {
        items: [{ id: 'pedido-' + n + '-r', title: ('Restante do pedido nº ' + n + ' · ' + (lj0.nome || 'Eita Vale')).slice(0, 250), quantity: 1, unit_price: vr, currency_id: 'BRL' }],
        marketplace_fee: Math.round(fr * 100) / 100,
        external_reference: n + '-r',
        notification_url: SU + '/functions/v1/mp-webhook?loja=' + ped.loja_id,
        back_urls: { success: APP + '?mppag=ok&r=1&n=' + n + '#/pedidos', pending: APP + '?mppag=pend&r=1&n=' + n + '#/pedidos', failure: APP + '?mppag=erro&r=1&n=' + n + '#/pedidos' },
        auto_return: 'approved',
        payment_methods: { installments: Math.max(1, Math.min(18, Number(lj0.parcelas_max || 1))), excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
        statement_descriptor: 'EITAVALE',
        payer: { name: String(ped.cliente || '').slice(0, 60) },
      };
      if (ped.rest_ate) { pr2.expires = true; pr2.expiration_date_to = bahia(ped.rest_ate); }
      const r2 = await fetch('https://api.mercadopago.com/checkout/preferences', { method: 'POST', headers: AH, body: JSON.stringify(pr2) });
      const j2 = await r2.json();
      if (!r2.ok || !j2.id) { console.error('pref2', r2.status, JSON.stringify(j2).slice(0, 400)); return out({ erro: 'Não foi possível abrir o pagamento agora. Tente de novo.' }, 502); }
      await fetch(SU + '/rest/v1/pedidos?id=eq.' + n, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ mp_pref_id2: String(j2.id) }) });
      return out({ url: j2.init_point });
    }

    if (ped.status !== 'confirmado') return out({ erro: ped.status === 'novo' ? 'Aguarde a loja aceitar o pedido.' : 'Este pedido não pode mais ser pago.' }, 400);
    if (ped.pg_status === 'pago') return out({ erro: 'Este pedido já está pago.' }, 400);
    if (ped.pg_status !== 'aguardando' || (ped.pag_ate && new Date(ped.pag_ate).getTime() < Date.now())) return out({ erro: 'O prazo para pagar terminou.' }, 400);
    const sn = ped.sinal_pct != null;
    const total = Math.round(Number(sn ? ped.v_sinal : ped.total) * 100) / 100;
    if (!(total > 0)) return out({ erro: 'Valor do pedido inválido.' }, 400);
    const fee = Math.max(0, Math.min(Number((sn ? ped.c_sinal : ped.comissao) || 0), total - 0.01));
    const lj = (await db('lojas?id=eq.' + ped.loja_id + '&select=nome,parcelas_max'))[0] || {};
    const ids = (ped.itens || []).map((i: any) => i.id).filter(Boolean);
    const pr = ids.length ? await db('produtos?id=in.(' + ids.join(',') + ')&select=id,parcela,parcelas_max') : [];
    let inst = Math.max(1, Math.min(18, Number(lj.parcelas_max || 1)));
    for (const x of pr as any[]) inst = x.parcela === false ? 1 : Math.min(inst, Math.max(1, Number(x.parcelas_max || inst)));
    const pref: any = {
      items: [{ id: 'pedido-' + n, title: ((sn ? 'Sinal (' + ped.sinal_pct + '%) do pedido nº ' : 'Pedido nº ') + n + ' · ' + (lj.nome || 'Eita Vale')).slice(0, 250), quantity: 1, unit_price: total, currency_id: 'BRL' }],
      marketplace_fee: Math.round(fee * 100) / 100,
      external_reference: String(n),
      notification_url: SU + '/functions/v1/mp-webhook?loja=' + ped.loja_id,
      back_urls: { success: APP + '?mppag=ok&n=' + n + '#/pedidos', pending: APP + '?mppag=pend&n=' + n + '#/pedidos', failure: APP + '?mppag=erro&n=' + n + '#/pedidos' },
      auto_return: 'approved',
      payment_methods: { installments: inst, excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
      statement_descriptor: 'EITAVALE',
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
