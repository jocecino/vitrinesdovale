// Etiquetas dos Correios pelo Melhor Envio, pagas com o saldo da conta da PRÓPRIA loja.
// Lojista (login): acao 'gerar' | 'imprimir' | 'cancelar' | 'atualizar'  (sempre de pedidos da própria loja)
// Agendador (x-notify-key): acao 'rastrear' -> confere todas as etiquetas e marca postado / entregue sozinho.
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ME = 'https://melhorenvio.com.br';
const UA = 'Eita Vale (contato.eitavale@gmail.com)';
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const db = async (path: string) => { const r = await fetch(SU + '/rest/v1/' + path, { headers: H }); return r.ok ? r.json() : []; };
const patch = (path: string, b: unknown) => fetch(SU + '/rest/v1/' + path, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(b) });
const rpc = async (f: string, b: unknown) => { const r = await fetch(SU + '/rest/v1/rpc/' + f, { method: 'POST', headers: H, body: JSON.stringify(b) }); return r.ok ? r.json() : null; };
const dig = (s: unknown) => String(s ?? '').replace(/\D/g, '');
class Erro extends Error { constructor(m: string, public extra: Record<string, unknown> = {}) { super(m); } }

// ---------- conta do Melhor Envio da loja (renova a chave sozinho) ----------
async function conta(loja: string) {
  const c = (await db('me_contas?loja_id=eq.' + loja + '&select=*'))[0];
  if (!c) throw new Erro('Conecte a conta do Melhor Envio da loja em "Entrega e frete" para gerar etiquetas.', { conectar: true });
  if (c.refresh_token && (!c.expira_em || new Date(c.expira_em).getTime() < Date.now() + 5 * 86400e3)) return await renovar(c);
  return c;
}
async function renovar(c: any) {
  const id = (Deno.env.get('ME_CLIENT_ID') || '').trim(), sec = (Deno.env.get('ME_CLIENT_SECRET') || '').trim();
  if (!id || !sec || !c.refresh_token) return c;
  const t = await fetch(ME + '/oauth/token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: id, client_secret: sec, refresh_token: c.refresh_token }) });
  const j = await t.json().catch(() => null);
  if (!t.ok || !j || !j.access_token) { console.error('renovar', t.status, JSON.stringify(j).slice(0, 200)); return c; }
  const n = { access_token: j.access_token, refresh_token: j.refresh_token || c.refresh_token, expira_em: new Date(Date.now() + (Number(j.expires_in) || 2592000) * 1000).toISOString(), atualizado_em: new Date().toISOString() };
  await patch('me_contas?loja_id=eq.' + c.loja_id, n);
  return { ...c, ...n };
}
async function api(c: any, met: string, path: string, body?: unknown) {
  const r = await fetch(ME + path, { method: met, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.access_token, 'User-Agent': UA }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (r.status === 401) throw new Erro('A conexão com o Melhor Envio expirou. Toque em "Conectar Melhor Envio" de novo em "Entrega e frete".', { conectar: true });
  return { ok: r.ok, status: r.status, j };
}
const msgME = (j: any) => { if (!j) return ''; if (typeof j.message === 'string' && !j.errors) return j.message; const e = j.errors || j.error; if (e && typeof e === 'object') return Object.values(e).flat().join(' '); return String(j.message || j.error || '').slice(0, 300); };

// ---------- gerar etiqueta ----------
async function gerar(ped: any, lj: any, nf: string) {
  if (!ped.frete_sid) throw new Erro('Este pedido não foi cotado pelos Correios.');
  if (ped.status !== 'confirmado') throw new Erro(ped.status === 'saiu' ? 'Este pedido já foi postado.' : 'Confirme o pedido antes de gerar a etiqueta.');
  if (ped.pagamento === 'mp' && ped.pg_status !== 'pago') throw new Erro('Aguarde o pagamento ser aprovado antes de gerar a etiqueta.');
  const doc = dig(lj.rem_doc), tel = dig(lj.rem_tel || lj.whatsapp);
  if (!lj.rem_nome || !(doc.length === 11 || doc.length === 14) || tel.length < 10) throw new Erro('Preencha os dados do remetente (nome, CPF ou CNPJ e telefone) em "Entrega e frete".', { remetente: true });
  if (!lj.cep || !lj.rua || !lj.numero) throw new Erro('Complete o endereço da loja (CEP, rua e número) para gerar a etiqueta.', { remetente: true });
  const chave = dig(nf || ped.nf_chave);
  if (lj.emite_nf && chave.length !== 44) throw new Erro('Informe a chave da nota fiscal (44 números) deste pedido.', { nf: true });
  const e = ped.end_json || {};
  if (!ped.cpf_dest || !e.rua || !ped.cep) throw new Erro('Este pedido não tem os dados completos do destinatário (CPF/endereço). Use "Copiar dados" e gere a etiqueta direto no site do Melhor Envio.');
  const c = await conta(lj.id);
  if (ped.me_status === 'gerada' && ped.me_etiqueta) return { ok: true, url: await imprimir(c, ped.me_etiqueta), tracking: ped.me_tracking || null };
  // medidas de cada item vêm do banco
  const its = Array.isArray(ped.itens) ? ped.itens : [];
  const ids = [...new Set(its.map((i: any) => i.id).filter(Boolean))];
  const ps = ids.length ? await db('produtos?id=in.(' + ids.join(',') + ')&select=id,peso_g,alt_cm,larg_cm,comp_cm') : [];
  const M: Record<string, any> = Object.fromEntries(ps.map((p: any) => [p.id, p]));
  let peso = 0, larg = 1, comp = 1, alt = 0;
  for (const i of its) {
    const p = M[i.id]; const q = Number(i.qtd || i.q || 1);
    if (!p || !p.peso_g) throw new Erro('Um dos produtos está sem peso/medidas. Cadastre em "Produtos" e tente de novo.');
    peso += Number(p.peso_g) * q; larg = Math.max(larg, Number(p.larg_cm)); comp = Math.max(comp, Number(p.comp_cm)); alt += Number(p.alt_cm) * q;
  }
  const valor = Math.round(Number(ped.subtotal || 0) * 100) / 100;
  let cli: any = null;
  if (ped.cliente_uid) cli = (await db('cliente_contas?user_id=eq.' + ped.cliente_uid + '&select=email'))[0];
  let cartId = ['carrinho', 'pago'].includes(ped.me_status) ? ped.me_etiqueta : null;
  if (!cartId) {
    const body = {
      service: Number(ped.frete_sid), agency: null,
      from: { name: String(lj.rem_nome).slice(0, 60), phone: tel, email: lj.email || 'contato.eitavale@gmail.com', ...(doc.length === 14 ? { company_document: doc, document: '' } : { document: doc }),
        address: lj.rua, number: String(lj.numero), complement: lj.complemento || '', district: lj.bairro || 'Centro', city: lj.cidade || 'Sobradinho', state_abbr: lj.uf || 'BA', country_id: 'BR', postal_code: dig(lj.cep) },
      to: { name: String(ped.cliente || 'Cliente').slice(0, 60), phone: dig(ped.tel), email: (cli && cli.email) || 'contato.eitavale@gmail.com', document: dig(ped.cpf_dest),
        address: e.rua, number: String(e.num || 'S/N'), complement: e.comp || '', district: e.bairro || 'Centro', city: e.cidade || ped.cidade, state_abbr: e.uf || ped.uf, country_id: 'BR', postal_code: dig(ped.cep), note: (e.ref || '').slice(0, 100) },
      products: its.map((i: any) => ({ name: String(i.titulo || 'Produto').slice(0, 80), quantity: Number(i.qtd || i.q || 1), unitary_value: Number(i.preco || 0) })),
      volumes: [{ height: Math.max(1, Math.ceil(alt)), width: Math.max(1, Math.ceil(larg)), length: Math.max(1, Math.ceil(comp)), weight: Math.max(0.01, Math.round(peso) / 1000) }],
      options: { insurance_value: valor, receipt: false, own_hand: false, reverse: false, non_commercial: !lj.emite_nf, ...(lj.emite_nf ? { invoice: { key: chave } } : {}), platform: 'Eita Vale', tags: [{ tag: 'Pedido #' + ped.id, url: null }] },
    };
    const r = await api(c, 'POST', '/api/v2/me/cart', body);
    if (!r.ok || !r.j || !r.j.id) { console.error('cart', r.status, JSON.stringify(r.j).slice(0, 400)); throw new Erro('O Melhor Envio recusou os dados da etiqueta: ' + (msgME(r.j) || 'erro ' + r.status)); }
    cartId = String(r.j.id);
    await patch('pedidos?id=eq.' + ped.id, { me_etiqueta: cartId, me_status: 'carrinho', nf_chave: chave || null });
  }
  const k = ped.me_status === 'pago' ? { ok: true, status: 200, j: null } : await api(c, 'POST', '/api/v2/me/shipment/checkout', { orders: [cartId] });
  if (!k.ok) {
    const m = msgME(k.j);
    console.error('checkout', k.status, JSON.stringify(k.j).slice(0, 300));
    if (/saldo|insuf|balance/i.test(m)) throw new Erro('Saldo insuficiente no Melhor Envio. Coloque saldo na conta da loja (app.melhorenvio.com.br → Carteira) e toque em "Gerar etiqueta" de novo.', { saldo: true });
    throw new Erro('Não foi possível pagar a etiqueta: ' + (m || 'erro ' + k.status));
  }
  await patch('pedidos?id=eq.' + ped.id, { me_status: 'pago' });
  const g = await api(c, 'POST', '/api/v2/me/shipment/generate', { orders: [cartId] });
  if (!g.ok) { console.error('generate', g.status, JSON.stringify(g.j).slice(0, 300)); throw new Erro('A etiqueta foi paga, mas ainda não foi gerada. Toque em "Gerar etiqueta" de novo em alguns minutos.'); }
  await patch('pedidos?id=eq.' + ped.id, { me_status: 'gerada', etiqueta_em: new Date().toISOString() });
  let trk = '';
  try { const o = await api(c, 'GET', '/api/v2/me/orders/' + cartId); trk = String(o.j && (o.j.tracking || o.j.self_tracking) || ''); } catch (_) { /* depois */ }
  if (trk) await patch('pedidos?id=eq.' + ped.id, { me_tracking: trk });
  const url = await imprimir(c, cartId);
  return { ok: true, url, tracking: trk || null };
}
async function imprimir(c: any, id: string) {
  const r = await api(c, 'POST', '/api/v2/me/shipment/print', { mode: 'public', orders: [id] });
  if (!r.ok || !r.j || !r.j.url) { console.error('print', r.status, JSON.stringify(r.j).slice(0, 300)); throw new Erro('Não foi possível abrir a etiqueta agora. Tente de novo em instantes.'); }
  return String(r.j.url);
}
async function cancelar(ped: any, lj: any) {
  if (!ped.me_etiqueta || !ped.me_status || ped.me_status === 'cancelada') throw new Erro('Este pedido não tem etiqueta para cancelar.');
  if (ped.status !== 'confirmado') throw new Erro('O pacote já foi postado: a etiqueta não pode mais ser cancelada aqui.');
  const c = await conta(lj.id);
  if (ped.me_status === 'carrinho') await api(c, 'DELETE', '/api/v2/me/cart/' + ped.me_etiqueta);
  else {
    const r = await api(c, 'POST', '/api/v2/me/shipment/cancel', { order: { id: ped.me_etiqueta, reason_id: '2', description: 'Cancelado pela loja (pedido #' + ped.id + ')' } });
    const ok = r.ok && r.j && (r.j[ped.me_etiqueta] ? r.j[ped.me_etiqueta].canceled !== false : true);
    if (!ok) { console.error('cancel', r.status, JSON.stringify(r.j).slice(0, 300)); throw new Erro('O Melhor Envio não aceitou o cancelamento: ' + (msgME(r.j) || 'erro ' + r.status)); }
  }
  await patch('pedidos?id=eq.' + ped.id, { me_status: 'cancelada', me_etiqueta: null, me_tracking: null, etiqueta_em: null });
  return { ok: true, msg: 'Etiqueta cancelada. O valor volta para o saldo da loja no Melhor Envio.' };
}

// ---------- rastreio automático ----------
async function rastrearLoja(loja: string, peds: any[]) {
  let c: any; try { c = await conta(loja); } catch (_) { return 0; }
  let n = 0;
  for (let i = 0; i < peds.length; i += 50) {
    const lote = peds.slice(i, i + 50);
    const r = await api(c, 'POST', '/api/v2/me/shipment/tracking', { orders: lote.map((p) => p.me_etiqueta) });
    if (!r.ok || !r.j || typeof r.j !== 'object') { console.error('tracking', r.status, JSON.stringify(r.j).slice(0, 200)); continue; }
    for (const p of lote) {
      const t = r.j[p.me_etiqueta]; if (!t) continue;
      const st = String(t.status || '').toLowerCase();
      const cod = String(t.tracking || t.melhorenvio_tracking || p.me_tracking || '').replace(/[^A-Za-z0-9]/g, '');
      if (cod && cod !== p.me_tracking) await patch('pedidos?id=eq.' + p.id, { me_tracking: cod });
      if (st === 'canceled' || st === 'cancelled') { await patch('pedidos?id=eq.' + p.id, { me_status: 'cancelada' }); n++; continue; }
      if (st === 'posted' || st === 'delivered' || t.posted_at) { if (p.status === 'confirmado') { await rpc('me_marcar', { p_id: p.id, p_acao: 'postado', p_codigo: cod }); n++; } }
      if (st === 'delivered' || t.delivered_at) { await rpc('me_marcar', { p_id: p.id, p_acao: 'entregue', p_codigo: cod }); n++; }
    }
  }
  return n;
}
async function rastrear(loja?: string) {
  const desde = new Date(Date.now() - 60 * 86400e3).toISOString();
  const peds = await db('pedidos?me_status=eq.gerada&status=in.(confirmado,saiu)&etiqueta_em=gte.' + desde + (loja ? '&loja_id=eq.' + loja : '') + '&select=id,loja_id,status,me_etiqueta,me_tracking&limit=500');
  const G: Record<string, any[]> = {};
  for (const p of peds) (G[p.loja_id] ||= []).push(p);
  let n = 0;
  for (const [l, ps] of Object.entries(G)) { try { n += await rastrearLoja(l, ps); } catch (x) { console.error('rastrear', l, String(x)); } }
  return { ok: true, conferidos: peds.length, mudancas: n };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const k = req.headers.get('x-notify-key') || '';
    if (k) {
      const cfg = await db('app_cfg?chave=eq.notify_key&select=valor');
      if (!(cfg[0] && cfg[0].valor === k)) return out({ erro: 'Sem permissão.' }, 403);
      return out(await rastrear());
    }
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const ur = await fetch(SU + '/auth/v1/user', { headers: { apikey: SK, Authorization: 'Bearer ' + jwt } });
    const u = ur.ok ? await ur.json() : null;
    if (!u || !u.id) return out({ erro: 'Entre na conta da loja.' }, 401);
    const lj = (await db('lojas?owner_id=eq.' + u.id + '&select=id,nome,email,whatsapp,cep,rua,numero,complemento,bairro,cidade,uf,rem_nome,rem_doc,rem_tel,emite_nf'))[0];
    if (!lj) return out({ erro: 'Loja não encontrada.' }, 403);
    const acao = String(b.acao || '');
    if (acao === 'atualizar') return out(await rastrear(lj.id));
    const id = Math.floor(Number(b.id));
    if (!(id > 0)) return out({ erro: 'Pedido inválido.' }, 400);
    const ped = (await db('pedidos?id=eq.' + id + '&loja_id=eq.' + lj.id + '&select=id,loja_id,status,pagamento,pg_status,itens,subtotal,cliente,tel,cliente_uid,cep,cidade,uf,cpf_dest,end_json,frete_sid,me_etiqueta,me_status,me_tracking,nf_chave'))[0];
    if (!ped) return out({ erro: 'Pedido não encontrado.' }, 404);
    if (acao === 'gerar') return out(await gerar(ped, lj, String(b.nf || '')));
    if (acao === 'imprimir') {
      if (!ped.me_etiqueta || !['gerada', 'pago'].includes(ped.me_status)) return out({ erro: 'Gere a etiqueta primeiro.' }, 400);
      return out({ ok: true, url: await imprimir(await conta(lj.id), ped.me_etiqueta) });
    }
    if (acao === 'cancelar') return out(await cancelar(ped, lj));
    return out({ erro: 'Ação inválida.' }, 400);
  } catch (x) {
    if (x instanceof Erro) return out({ erro: x.message, ...x.extra }, 400);
    console.error('me-etiqueta', String(x)); return out({ erro: 'Falha ao falar com o Melhor Envio. Tente de novo em instantes.' }, 500);
  }
});
