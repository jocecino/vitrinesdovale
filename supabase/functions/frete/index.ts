// Cotação de frete para outras cidades (Melhor Envio). Os dados dos produtos e da loja vêm do banco, nunca do aparelho.
// A cotação fica guardada (frete_cotacoes) e é conferida pelo servidor na hora do pedido.
const SU = Deno.env.get('SUPABASE_URL')!, SK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ME = 'https://melhorenvio.com.br/api/v2/me/shipment/calculate';
const UA = 'Eita Vale (contato.eitavale@gmail.com)';
// Só Correios por enquanto (PAC, SEDEX e Mini Envios): é o que a loja consegue postar na agência da cidade.
const SERV = '1,2,17';
const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const db = async (path: string) => { const r = await fetch(SU + '/rest/v1/' + path, { headers: H }); return r.ok ? r.json() : []; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function alertaToken(msg: string) {
  try { await fetch(SU + '/rest/v1/rpc/me_alerta', { method: 'POST', headers: H, body: JSON.stringify({ p_txt: msg }) }); } catch (_) { /* ignore */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const cep = String(b.cep || '').replace(/\D/g, '');
    if (cep.length !== 8) return out({ erro: 'CEP inválido.' }, 400);
    if (!UUID.test(String(b.loja || ''))) return out({ erro: 'Loja inválida.' }, 400);
    const its = Array.isArray(b.itens) ? b.itens.slice(0, 15) : [];
    const qt: Record<string, number> = {};
    for (const i of its) { const id = String(i && i.id || ''); const q = Math.floor(Number(i && i.q)); if (!UUID.test(id) || !(q >= 1 && q <= 99)) return out({ erro: 'Itens inválidos.' }, 400); qt[id] = (qt[id] || 0) + q; }
    const ids = Object.keys(qt).sort();
    if (!ids.length) return out({ erro: 'Itens inválidos.' }, 400);
    const lj = (await db('lojas?id=eq.' + b.loja + '&select=id,cep,cidade,uf,entrega_area,postagem_dias,status'))[0];
    if (!lj || !['ativa'].includes(lj.status)) return out({ erro: 'Loja indisponível.' }, 400);
    if (lj.entrega_area !== 'fora') return out({ so_cidade: true });
    if (!lj.cep) return out({ falha: true, motivo: 'loja_sem_cep' });
    const ps = await db('produtos?id=in.(' + ids.join(',') + ')&select=id,loja_id,ativo,tipo,preco,oferta_preco,oferta_ate,peso_g,alt_cm,larg_cm,comp_cm');
    if (!Array.isArray(ps) || ps.length !== ids.length || ps.some((p: any) => p.loja_id !== lj.id || !p.ativo || p.tipo === 'servico')) return out({ erro: 'Um dos produtos não está disponível.' }, 400);
    if (ps.some((p: any) => !(p.peso_g && p.alt_cm && p.larg_cm && p.comp_cm))) return out({ sem_medidas: true });
    const itens = ids.map((id) => ({ id, q: qt[id] }));
    // mesma cotação recente? reaproveita (evita chamadas repetidas)
    const recente = new Date(Date.now() - 10 * 60e3).toISOString();
    const rc = await db('frete_cotacoes?loja_id=eq.' + lj.id + '&cep=eq.' + cep + '&itens=eq.' + encodeURIComponent(JSON.stringify(itens)) + '&criado_em=gte.' + recente + '&select=id,opcoes&order=criado_em.desc&limit=1');
    if (Array.isArray(rc) && rc[0]) return out({ cotacao: rc[0].id, opcoes: rc[0].opcoes, postagem: lj.postagem_dias });
    const tok = (Deno.env.get('ME_TOKEN') || '').trim();
    if (!tok) return out({ falha: true, motivo: 'sem_token' });
    const now = Date.now();
    const products = ps.map((p: any) => {
      const pr = p.oferta_ate && new Date(p.oferta_ate).getTime() > now && Number(p.oferta_preco) > 0 ? Number(p.oferta_preco) : Number(p.preco);
      return { id: p.id, width: Math.max(1, Math.ceil(Number(p.larg_cm))), height: Math.max(1, Math.ceil(Number(p.alt_cm))), length: Math.max(1, Math.ceil(Number(p.comp_cm))), weight: Math.max(0.001, Number(p.peso_g) / 1000), insurance_value: Math.round(pr * 100) / 100, quantity: qt[p.id] };
    });
    let r: Response;
    try {
      r = await fetch(ME, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, 'User-Agent': UA }, body: JSON.stringify({ from: { postal_code: lj.cep }, to: { postal_code: cep }, products, options: { receipt: false, own_hand: false }, services: SERV }) });
    } catch (e) { console.error('me rede', String(e)); return out({ falha: true, motivo: 'rede' }); }
    if (r.status === 401 || r.status === 403) { console.error('me auth', r.status); await alertaToken('A chave do Melhor Envio (ME_TOKEN) foi recusada (erro ' + r.status + '). O frete para outras cidades voltou para "a combinar no chat" até a chave ser trocada no Supabase.'); return out({ falha: true, motivo: 'token' }); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(j)) { console.error('me', r.status, JSON.stringify(j).slice(0, 300)); return out({ falha: true, motivo: 'me' }); }
    const pd = Number(lj.postagem_dias) || 2;
    let ops = j.filter((s: any) => !s.error && Number(s.custom_price || s.price) > 0).map((s: any) => ({
      sid: Number(s.id), empresa: String(s.company && s.company.name || ''), servico: String(s.name || ''),
      preco: Math.round(Number(s.custom_price || s.price) * 100) / 100,
      prazo: Number(s.custom_delivery_time || s.delivery_time || 0) + pd,
    })).filter((o: any) => o.sid && o.prazo > 0);
    ops.sort((a: any, b: any) => a.preco - b.preco || a.prazo - b.prazo);
    ops = ops.filter((o: any) => [1, 2, 17].includes(o.sid)).slice(0, 4);
    if (!ops.length) return out({ falha: true, motivo: 'sem_opcao' });
    const w = await fetch(SU + '/rest/v1/frete_cotacoes', { method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify({ loja_id: lj.id, cep, itens, opcoes: ops }) });
    const wj = await w.json().catch(() => null);
    if (!w.ok || !wj || !wj[0]) { console.error('salvar', w.status); return out({ falha: true, motivo: 'salvar' }); }
    if (Math.random() < 0.05) fetch(SU + '/rest/v1/frete_cotacoes?criado_em=lt.' + new Date(Date.now() - 2 * 86400e3).toISOString(), { method: 'DELETE', headers: H }).catch(() => {});
    return out({ cotacao: wj[0].id, opcoes: ops, postagem: pd });
  } catch (x) { console.error('falha', String(x)); return out({ falha: true, motivo: 'erro' }); }
});
