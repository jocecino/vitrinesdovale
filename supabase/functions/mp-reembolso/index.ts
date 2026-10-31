// Cancela um pedido pago e devolve o valor ao cliente pelo Mercado Pago (estorno total).
// Pode ser chamado pela loja dona do pedido (pedido confirmado ou saiu para entrega) ou pelo administrador.
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const db = async (path: string) => { const r = await fetch(SU + '/rest/v1/' + path, { headers: H }); return r.ok ? r.json() : []; };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const nk = req.headers.get('x-notify-key') || '';
    const cfg = nk ? (await db('app_cfg?chave=eq.notify_key&select=valor'))[0] : null;
    const auto = !!(nk && cfg && cfg.valor === nk);
    let user: any = null;
    if (!auto) {
      const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const ur = await fetch(SU + '/auth/v1/user', { headers: { apikey: SK, Authorization: 'Bearer ' + jwt } });
      user = ur.ok ? await ur.json() : null;
      if (!user || !user.id) return out({ erro: 'Entre novamente na sua conta.' }, 401);
    }
    const b = await req.json().catch(() => ({}));
    const n = parseInt(b.numero, 10);
    if (!n) return out({ erro: 'Pedido inválido.' }, 400);
    const ped = (await db('pedidos?id=eq.' + n + '&select=id,loja_id,status,pagamento,pg_status,mp_payment_id,total,direto,loja_ok_em'))[0];
    if (!ped) return out({ erro: 'Pedido não encontrado.' }, 404);
    if (auto && (!ped.direto || ped.loja_ok_em || ped.status !== 'confirmado')) return out({ erro: 'Pedido não elegível para devolução automática.' }, 400);
    const adm = auto || (await db('admins?user_id=eq.' + user.id + '&select=user_id')).length > 0;
    const lj = (await db('lojas?id=eq.' + ped.loja_id + '&select=owner_id'))[0];
    const dono = !auto && lj && lj.owner_id === user.id;
    if (!adm && !dono) return out({ erro: 'Sem permissão para este pedido.' }, 403);
    if (ped.pagamento !== 'mp' || ped.pg_status !== 'pago' || !ped.mp_payment_id) return out({ erro: 'Este pedido não tem pagamento para devolver.' }, 400);
    if (!adm && !['confirmado', 'saiu'].includes(ped.status)) return out({ erro: 'Pedido entregue: para devolver, fale com o suporte.' }, 400);
    const ct = (await db('mp_contas?loja_id=eq.' + ped.loja_id + '&select=access_token'))[0];
    if (!ct) return out({ erro: 'A loja não está conectada ao Mercado Pago.' }, 400);
    const r = await fetch('https://api.mercadopago.com/v1/payments/' + ped.mp_payment_id + '/refunds', {
      method: 'POST', headers: { Authorization: 'Bearer ' + ct.access_token, 'Content-Type': 'application/json', 'X-Idempotency-Key': 'vv-refund-' + n }, body: '{}' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('refund', r.status, JSON.stringify(j).slice(0, 300));
      // 2031 = "Collector hasn't enough available money": a loja não tem saldo disponível no Mercado Pago
      const saldo = /2031|available money|enough|insufficient/i.test(JSON.stringify(j));
      if (auto) await fetch(SU + '/rest/v1/rpc/alerta_registrar', { method: 'POST', headers: H, body: JSON.stringify({ p_tipo: 'devolução automática', p_texto: 'Não foi possível devolver automaticamente o pedido nº ' + n + ' (a loja não confirmou em 36 h). Motivo: ' + (saldo ? 'conta Mercado Pago da loja sem saldo.' : 'o Mercado Pago recusou agora.') + ' O sistema tenta de novo a cada 6 horas. Se preferir, fale com a loja.' }) }).catch(() => {});
      return out({ erro: saldo ? 'A conta Mercado Pago da loja está sem saldo disponível para devolver. Coloque saldo na conta (por exemplo, por Pix) ou aguarde a liberação do dinheiro das vendas e tente de novo.' : 'O Mercado Pago não aceitou a devolução agora. Tente de novo mais tarde.' }, 502);
    }
    await fetch(SU + '/rest/v1/rpc/mp_reembolso_registrar', { method: 'POST', headers: H, body: JSON.stringify({ p_pedido: n, p_por: auto ? 'auto' : adm && !dono ? 'admin' : 'loja' }) });
    return out({ ok: true });
  } catch (x) { console.error('falha', String(x)); return out({ erro: 'Erro inesperado. Tente de novo.' }, 500); }
});
