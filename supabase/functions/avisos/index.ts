import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";
import webpush from "npm:web-push@3.6.7";

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const SITE = "https://eitavale.com.br/";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
// campanha só de algumas cidades (lista vazia = todas)
const cidOk = (cs: string[] | null, cid: string | null) => !cs || !cs.length || cs.some((x) => x.trim().toLowerCase() === String(cid || "").trim().toLowerCase());
const brl = (n: number) => "R$ " + Number(n || 0).toFixed(2).replace(".", ",");

async function cfg(k: string) {
  const { data } = await db.from("app_cfg").select("valor").eq("chave", k).maybeSingle();
  return data?.valor as string | undefined;
}

let vapidOk = false;
async function vapid() {
  if (vapidOk) return true;
  const [pub, priv, sub] = await Promise.all([cfg("vapid_public"), cfg("vapid_private"), cfg("vapid_subject")]);
  if (!pub || !priv) return false;
  webpush.setVapidDetails(sub || "mailto:contato.eitavale@gmail.com", pub, priv);
  vapidOk = true;
  return true;
}

async function enviarPush(lojaId: string, p: { title: string; body: string; url?: string; tag?: string }) {
  if (!(await vapid())) return 0;
  const { data: subs } = await db.from("push_subs").select("id,endpoint,p256dh,auth").eq("loja_id", lojaId);
  let ok = 0;
  for (const s of (subs || []) as Array<{ id: number; endpoint: string; p256dh: string; auth: string }>) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ url: "/#/minha", ...p }), { TTL: 3600 * 12, urgency: "high" });
      ok++;
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode;
      if (sc === 404 || sc === 410) await db.from("push_subs").delete().eq("id", s.id);
      else console.error("push", sc, String(e).slice(0, 200));
    }
  }
  return ok;
}

async function enviarPushCli(uid: string, p: { title: string; body: string; url?: string; tag?: string }) {
  if (!(await vapid())) return 0;
  const { data: subs } = await db.from("push_cli").select("id,endpoint,p256dh,auth").eq("cliente_uid", uid);
  let ok = 0;
  for (const s of (subs || []) as Array<{ id: number; endpoint: string; p256dh: string; auth: string }>) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ url: "/#/pedidos", ...p }), { TTL: 3600 * 12, urgency: "high" });
      ok++;
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode;
      if (sc === 404 || sc === 410) await db.from("push_cli").delete().eq("id", s.id);
      else console.error("pushcli", sc, String(e).slice(0, 200));
    }
  }
  return ok;
}

function smtp() {
  const user = Deno.env.get("GMAIL_USER"), pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) return null;
  return { user: user.trim(), t: nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: user.trim(), pass: pass.replace(/\s+/g, "") } }) };
}

async function logar(acao: string, ok: boolean, erro?: string) {
  try { await db.from("email_log").insert({ acao, ok, erro: erro ? erro.slice(0, 400) : null }); } catch (_) { /* ignore */ }
}

function moldura(titulo: string, corpo: string, botao: string, link: string, rodape: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:20px">
<h2 style="margin:0 0 12px;color:#16363F">${esc(titulo)}</h2>${corpo}
<p style="text-align:center;margin:22px 0"><a href="${esc(link)}" style="background:#16363F;color:#E9D08A;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:8px;display:inline-block">${esc(botao)}</a></p>
<p style="color:#666;font-size:13px">${esc(rodape)}</p><p style="color:#999;font-size:12px">Eita Vale</p></div>`;
}

async function pegarTudo<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 100; i++) {
    const { data } = await q(i * 1000, i * 1000 + 999);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// only/para: usados só no teste interno (uma loja, e-mail de destino trocado)
async function resumoSemanal(only?: string, para?: string) {
  const s = smtp();
  if (!s) { await logar("resumo", false, "SEM_CONFIG"); return { enviados: 0 }; }
  const desde = new Date(Date.now() - 7 * 864e5).toISOString();
  let q = db.from("lojas").select("id,nome,email").eq("status", "ativa").not("email", "is", null);
  q = only ? q.eq("id", only) : q.eq("resumo_semanal", true);
  const { data: lojas } = await q;
  const peds = await pegarTudo<{ loja_id: string; total: number; status: string; itens: unknown }>((a, b) => db.from("pedidos").select("loja_id,total,status,itens").gte("criado_em", desde).range(a, b));
  const evs = await pegarTudo<{ tipo: string; alvo: string }>((a, b) => db.from("eventos").select("tipo,alvo").gte("ts", desde).in("tipo", ["loja", "produto"]).range(a, b));
  const prods = await pegarTudo<{ id: string; titulo: string; loja_id: string }>((a, b) => db.from("produtos").select("id,titulo,loja_id").range(a, b));
  const pLoja = new Map(prods.map((p) => [p.id, p]));
  let enviados = 0;
  for (const l of (lojas || []) as Array<{ id: string; nome: string; email: string }>) {
    const dest = para || l.email;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest || "")) continue;
    const mp = peds.filter((p) => p.loja_id === l.id && p.status !== "cancelado" && p.status !== "recusado");
    const total = mp.reduce((a, p) => a + Number(p.total || 0), 0);
    const visitas = evs.filter((e) => e.tipo === "loja" && e.alvo === l.id).length;
    const vis: Record<string, number> = {}, vend: Record<string, number> = {};
    for (const e of evs) if (e.tipo === "produto" && pLoja.get(e.alvo)?.loja_id === l.id) vis[e.alvo] = (vis[e.alvo] || 0) + 1;
    for (const p of mp) for (const i of (Array.isArray(p.itens) ? p.itens : []) as Array<Record<string, unknown>>) {
      const id = String(i.id || "");
      const nome = String(i.titulo || pLoja.get(id)?.titulo || "Produto");
      vend[nome] = (vend[nome] || 0) + Number(i.qtd || i.q || 1);
    }
    const topV = Object.entries(vis).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => `${pLoja.get(id)?.titulo || "Produto"} (${n} ${n === 1 ? "visita" : "visitas"})`);
    const topS = Object.entries(vend).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([nome, n]) => `${nome} (${n} un.)`);
    const vazio = mp.length === 0 && visitas === 0;
    const caixa = (n: string, t: string) => `<td style="background:#f3f1ea;border-radius:10px;padding:12px 4px;text-align:center;width:33%"><div style="font-size:18px;font-weight:bold;color:#16363F;white-space:nowrap">${esc(n)}</div><div style="font-size:12px;color:#666">${esc(t)}</div></td>`;
    const lista = (t: string, a: string[]) => a.length ? `<p style="margin:14px 0 4px;font-weight:bold">${t}</p><ul style="margin:0;padding-left:18px;color:#333">${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
    const corpo = `<p style="margin:6px 0">Olá, <b>${esc(l.nome)}</b>! Veja como foram os últimos 7 dias:</p>
<table role="presentation" style="width:100%;border-spacing:8px;margin:8px -8px"><tr>${caixa(String(mp.length), mp.length === 1 ? "pedido" : "pedidos")}${caixa(brl(total), "vendido")}${caixa(String(visitas), visitas === 1 ? "visita na loja" : "visitas na loja")}</tr></table>
${lista("🔥 Mais vistos", topV)}${lista("🏆 Mais vendidos", topS)}
${vazio ? '<p style="margin:14px 0;color:#333">Semana tranquila por aqui. Dica: ative uma <b>oferta relâmpago</b>, cadastre novas cores e confira se as fotos estão bonitas. Isso ajuda a atrair mais clientes.</p>' : ""}`;
    try {
      await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: dest, subject: `${para ? "[TESTE] " : ""}📊 Seu resumo da semana - ${l.nome}`,
        text: `Resumo da semana de ${l.nome}\nPedidos: ${mp.length}\nVendido: ${brl(total)}\nVisitas na loja: ${visitas}\n${topV.length ? "Mais vistos: " + topV.join(", ") + "\n" : ""}${topS.length ? "Mais vendidos: " + topS.join(", ") + "\n" : ""}Abrir painel: ${SITE}#/minha`,
        html: moldura("📊 Seu resumo da semana", corpo, "Abrir meu painel", SITE + "#/minha", "Para parar de receber este e-mail, desligue a opção em Menu da loja > Loja.") });
      await logar("resumo", true); enviados++;
    } catch (e) { await logar("resumo", false, String(e)); }
  }
  return { enviados };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ erro: "Método inválido." }, 405);
  const k = req.headers.get("x-notify-key") || "";
  const ck = await cfg("notify_key");
  if (!k || !ck || k !== ck) return json({ erro: "Não autorizado." }, 401);
  let b: Record<string, string>;
  try { b = await req.json(); } catch (_) { return json({ erro: "Pedido inválido." }, 400); }
  const tipo = String(b.tipo || ""), id = String(b.id || "");
  try {
    if (tipo === "pedido_novo") {
      const { data: p } = await db.from("pedidos").select("id,loja_id,cliente,total").eq("id", Number(id)).maybeSingle();
      if (!p) return json({ ok: false });
      const n = await enviarPush(p.loja_id, { title: `🛒 Novo pedido nº ${p.id}`, body: `${p.cliente || "Cliente"} · ${brl(Number(p.total))}`, url: "/#/minha", tag: "pedido-" + p.id });
      return json({ ok: true, enviados: n });
    }
    if (tipo === "postagem_lembrete") {
      const { data: p } = await db.from("pedidos").select("id,loja_id,cliente,frete_servico,rastreio,status").eq("id", Number(id)).maybeSingle();
      if (!p || p.rastreio || p.status !== "confirmado") return json({ ok: false });
      const n = await enviarPush(p.loja_id, { title: `📦 Pedido nº ${p.id} aguardando postagem`, body: `${p.cliente || "Cliente"} · ${p.frete_servico || "Correios"}. Poste o pacote e informe o rastreio no painel.`, url: "/#/minha", tag: "postar-" + p.id });
      const { data: l } = await db.from("lojas").select("nome,email").eq("id", p.loja_id).maybeSingle();
      const s = smtp();
      if (s && l?.email) {
        try {
          await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: l.email, subject: `📦 Pedido nº ${p.id} aguardando postagem - Eita Vale`,
            text: `O pedido nº ${p.id} (${p.frete_servico || "Correios"}) foi confirmado há mais de 1 dia e ainda não foi postado. Poste o pacote e informe o rastreio no painel: ${SITE}#/minha`,
            html: moldura("📦 Pedido aguardando postagem", `<p>O pedido nº <b>${p.id}</b> da loja <b>${esc(l.nome)}</b> (${esc(p.frete_servico || "Correios")}) foi confirmado há mais de 1 dia e ainda não foi postado.</p><p>Leve o pacote à agência ou ponto de coleta e informe o rastreio no painel. Se gerou a etiqueta pelo Melhor Envio, o rastreio entra sozinho.</p>`, "Abrir meu painel", SITE + "#/minha", "Este aviso é enviado uma única vez por pedido.") });
          await logar("postagem_lembrete", true);
        } catch (e) { await logar("postagem_lembrete", false, String(e)); }
      }
      return json({ ok: true, enviados: n });
    }
    if (tipo === "encomenda_atraso") {
      const { data: p } = await db.from("pedidos").select("id,loja_id,cliente,status,pronto_em").eq("id", Number(id)).maybeSingle();
      if (!p || p.pronto_em || p.status !== "confirmado") return json({ ok: false });
      const n = await enviarPush(p.loja_id, { title: `⏰ Encomenda nº ${p.id} atrasada`, body: `${p.cliente || "Cliente"}: passou 2 dias da data prevista. Marque "Pronto" ou combine um novo prazo pelo chat.`, url: "/#/minha", tag: "atraso-" + p.id });
      const { data: l } = await db.from("lojas").select("nome,email").eq("id", p.loja_id).maybeSingle();
      const s = smtp();
      if (s && l?.email) {
        try {
          await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: l.email, subject: `⏰ Encomenda nº ${p.id} atrasada - Eita Vale`,
            text: `A encomenda do pedido nº ${p.id} passou 2 dias da data prevista e ainda não foi marcada como pronta. Marque "Pronto" no painel ou combine um novo prazo com o cliente pelo chat. O cliente já pode pedir o cancelamento. ${SITE}#/minha`,
            html: moldura("⏰ Encomenda atrasada", `<p>A encomenda do pedido nº <b>${p.id}</b> da loja <b>${esc(l.nome)}</b> passou 2 dias da data prevista e ainda não foi marcada como pronta.</p><p>Marque <b>Pronto</b> no painel assim que terminar, ou combine um novo prazo com o cliente pelo chat do pedido. A partir de agora o cliente pode pedir o cancelamento.</p>`, "Abrir meu painel", SITE + "#/minha", "Este aviso é enviado uma única vez por pedido.") });
          await logar("encomenda_atraso", true);
        } catch (e) { await logar("encomenda_atraso", false, String(e)); }
      }
      return json({ ok: true, enviados: n });
    }
    if (tipo === "campanha_nova") {
      const { data: c } = await db.from("campanhas").select("id,nome,tag,ativo,cidades").eq("id", id).maybeSingle();
      if (!c || !c.ativo) return json({ ok: false });
      const { data: ls } = await db.from("lojas").select("id,cidade").eq("status", "ativa");
      let n = 0;
      for (const l of (ls || []) as Array<{ id: string; cidade: string | null }>) {
        if (!cidOk(c.cidades, l.cidade)) continue;
        n += await enviarPush(l.id, { title: `🎉 Nova campanha: ${c.tag}`, body: `${c.nome} · toque para escolher os produtos que vão participar.`, url: "/#/minha", tag: "campanha-" + c.id });
      }
      return json({ ok: true, enviados: n });
    }
    if (tipo === "campanha_teste") {
      const { data: c } = await db.from("campanhas").select("id,nome,tag,status,teste_loja").eq("id", id).maybeSingle();
      if (!c || !c.teste_loja || c.status === "lancada") return json({ ok: false });
      const n = await enviarPush(c.teste_loja, { title: `🧪 TESTE · Nova campanha: ${c.tag}`, body: `${c.nome} · só a sua loja recebeu este aviso de teste.`, url: "/#/minha", tag: "campanha-teste-" + c.id });
      return json({ ok: true, enviados: n });
    }
    if (tipo === "pergunta_nova") {
      const { data: q } = await db.from("perguntas").select("id,loja_id,produto,pergunta").eq("id", id).maybeSingle();
      if (!q) return json({ ok: false });
      const n = await enviarPush(q.loja_id, { title: "💬 Nova pergunta de cliente", body: `${q.produto || "Produto"}: ${String(q.pergunta || "").slice(0, 100)}`, url: "/#/minha", tag: "pergunta-" + q.id });
      return json({ ok: true, enviados: n });
    }
    if (tipo === "suporte_admin") {
      const { data: m } = await db.from("suporte_msgs").select("id,loja_id,texto").eq("id", Number(id)).maybeSingle();
      if (!m) return json({ ok: false });
      const n = await enviarPush(m.loja_id, { title: "🛟 O Eita Vale respondeu seu suporte", body: String(m.texto || "").slice(0, 100), url: "/#/minha", tag: "suporte-" + m.id });
      return json({ ok: true, enviados: n });
    }
    if (tipo === "suporte_lojista") {
      const { data: m } = await db.from("suporte_msgs").select("id,loja_id,texto").eq("id", Number(id)).maybeSingle();
      if (!m) return json({ ok: false });
      const { data: l } = await db.from("lojas").select("nome").eq("id", m.loja_id).maybeSingle();
      const s = smtp();
      if (s) {
        try {
          await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: s.user, subject: `🛟 Suporte: mensagem de ${l?.nome || "loja"}`,
            text: `${l?.nome || "Loja"} escreveu no suporte:\n\n${m.texto}\n\nResponder: ${SITE}#/admin`,
            html: moldura("🛟 Nova mensagem no suporte", `<p><b>${esc(l?.nome || "Loja")}</b> escreveu:</p><p style="background:#f3f1ea;border-radius:10px;padding:12px;white-space:pre-wrap">${esc(m.texto)}</p>`, "Abrir o suporte", SITE + "#/admin", "Responda pelo painel do administrador, em Suporte.") });
          await logar("suporte", true);
        } catch (e) { await logar("suporte", false, String(e)); }
      }
      return json({ ok: true });
    }
    if (tipo === "loja_voltou") {
      const { data: l } = await db.from("lojas").select("id,nome,email,status").eq("id", id).maybeSingle();
      if (!l) return json({ ok: false });
      const n = await enviarPush(l.id, { title: "🟢 Sua loja voltou ao ar", body: "A data de volta chegou. Sua loja já aparece na vitrine e recebe pedidos.", url: "/#/minha", tag: "loja-voltou" });
      const s = smtp();
      if (s && l.email) {
        try {
          await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: l.email, subject: "🟢 Sua loja voltou ao ar - Eita Vale",
            text: `A data de volta chegou e a loja ${l.nome} já está no ar. Abrir painel: ${SITE}#/minha`,
            html: moldura("Sua loja voltou ao ar!", `<p>A data de volta que você escolheu chegou. A loja <b>${esc(l.nome)}</b> já aparece na vitrine e pode receber pedidos novamente.</p>`, "Abrir meu painel", SITE + "#/minha", "Você pode tirar a loja do ar de novo quando quiser, pelo painel.") });
          await logar("loja_voltou", true);
        } catch (e) { await logar("loja_voltou", false, String(e)); }
      }
      return json({ ok: true, enviados: n });
    }
    if (tipo === "avaliar_lembrete") {
      const { data: p } = await db.from("pedidos").select("id,loja,cliente,cliente_uid,status,adulto").eq("id", Number(id)).maybeSingle();
      if (!p || p.status !== "entregue" || !p.cliente_uid) return json({ ok: false });
      if (p.adulto) p.loja = "loja";
      const { data: c } = await db.from("cliente_contas").select("email,nome").eq("user_id", p.cliente_uid).maybeSingle();
      const s = smtp();
      if (!s || !c?.email) return json({ ok: false });
      const ult = String(b.n || "") === "2", nome = String(c.nome || p.cliente || "").trim().split(" ")[0], link = SITE + "#/avaliar/" + p.id;
      try {
        await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: c.email,
          subject: ult ? `⏰ Último dia para avaliar sua compra na ${p.loja}` : `⭐ Como foi sua compra na ${p.loja}?`,
          text: `Olá${nome ? ", " + nome : ""}! ${ult ? "Faltam poucos dias para avaliar" : "Conte como foi"} o seu pedido nº ${p.id} na ${p.loja}. Leva menos de 1 minuto: ${link}`,
          html: moldura(ult ? "⏰ Ainda dá tempo de avaliar" : "⭐ Como foi sua compra?", `<p>Olá${nome ? ", " + esc(nome) : ""}!</p><p>Seu pedido nº <b>${p.id}</b> na <b>${esc(p.loja)}</b> foi entregue. Conte como foi: dê estrelas para o produto, o atendimento e a entrega.</p><p>Sua avaliação ajuda outros clientes do Vale e faz as melhores lojas aparecerem primeiro.</p>`, "Avaliar agora", link, ult ? "Este é o último lembrete. O prazo para avaliar é de 7 dias após a entrega." : "Leva menos de 1 minuto. O prazo é de 7 dias após a entrega.") });
        await logar("avaliar_lembrete", true);
      } catch (e) { await logar("avaliar_lembrete", false, String(e)); }
      return json({ ok: true });
    }
    // pedido em 2 partes (sinal): avisos para a loja
    if (tipo === "loja_ped") {
      const { data: p } = await db.from("pedidos").select("id,loja_id,cliente,total,sinal_valor,sinal_pct,tipo,frete_servico,servico").eq("id", Number(id)).maybeSingle();
      if (!p) return json({ ok: false });
      const k = String(b.k || ""), cl = p.cliente || "Cliente";
      const M: Record<string, [string, string, string]> = {
        restante_pago: [`💰 Restante pago · pedido nº ${p.id}`, `${cl} pagou o restante. ${p.servico ? "O pedido está quitado." : p.tipo === "retirada" ? "Combine a retirada." : p.frete_servico ? "Já pode postar." : "Já pode entregar."}`, "O cliente pagou o restante do pedido pelo Mercado Pago. Agora o pedido está quitado e você já pode entregar (ou postar, ou combinar a retirada)."],
        desistiu: [`❌ Cliente desistiu · pedido nº ${p.id}`, `${cl} desistiu. O sinal (${brl(Number(p.sinal_valor))}) fica com você.`, `O cliente desistiu do pedido. Conforme a regra aceita na compra, o sinal de ${brl(Number(p.sinal_valor))} fica com você para cobrir os custos de produção. Não é preciso devolver nada.`],
        rest_expirou: [`⌛ Prazo do restante terminou · pedido nº ${p.id}`, `${cl} não pagou o restante em 3 dias. O pedido foi cancelado e o sinal fica com você.`, `O cliente não pagou o restante em até 3 dias depois do aviso de pronto. O pedido foi cancelado e, conforme a regra aceita na compra, o sinal de ${brl(Number(p.sinal_valor))} fica com você.`],
      };
      const m = M[k];
      if (!m) return json({ ok: false });
      const n = await enviarPush(p.loja_id, { title: m[0], body: m[1], url: "/#/minha", tag: "lp-" + p.id + "-" + k });
      const { data: l } = await db.from("lojas").select("nome,email").eq("id", p.loja_id).maybeSingle();
      const s = smtp();
      if (s && l?.email) {
        try {
          await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: l.email, subject: `${m[0]} - Eita Vale`, text: `${m[2]} ${SITE}#/minha`,
            html: moldura(m[0], `<p>Pedido nº <b>${p.id}</b> da loja <b>${esc(l.nome)}</b>.</p><p>${esc(m[2])}</p>`, "Abrir meu painel", SITE + "#/minha", "Aviso automático do Eita Vale.") });
          await logar("loja_ped_" + k, true);
        } catch (e) { await logar("loja_ped_" + k, false, String(e)); }
      }
      return json({ ok: true, enviados: n });
    }
    // teste de aviso pedido pelo lojista no painel
    if (tipo === "loja_teste") {
      const n = await enviarPush(id, { title: "🔔 Teste de aviso do Eita Vale", body: "Tudo certo! É assim que os pedidos novos vão chegar neste aparelho.", url: "/#/minha", tag: "teste" });
      return json({ ok: true, enviados: n });
    }
    // loja parada: falta conectar o Mercado Pago e/ou cadastrar produtos (a cada 3 dias, até 10 vezes)
    if (tipo === "loja_parada") {
      const { data: l } = await db.from("lojas").select("id,nome,email,responsavel,status").eq("id", id).maybeSingle();
      if (!l || l.status !== "ativa") return json({ ok: false });
      const f = (Array.isArray((b as unknown as { falta: string[] }).falta) ? (b as unknown as { falta: string[] }).falta : []) as string[];
      const mp = f.includes("mp"), pr = f.includes("produto");
      if (!mp && !pr) return json({ ok: false });
      const falta = mp && pr ? "conectar o Mercado Pago e cadastrar seus produtos" : mp ? "conectar o Mercado Pago" : "cadastrar seus produtos";
      const t = "Sua loja está quase no ar", tx = `Falta só ${falta} para a ${l.nome} aparecer na vitrine do Eita Vale.`;
      const n = await enviarPush(l.id, { title: "🏪 " + t, body: tx, url: "/#/minha", tag: "parada" });
      const s = smtp();
      if (s && l.email) {
        const nome = String(l.responsavel || "").trim().split(" ")[0];
        const passos = (mp ? `<li><b>Conectar o Mercado Pago:</b> no painel, Menu da loja › Pagamentos › Conectar. É por ele que o dinheiro das vendas cai na sua conta.</li>` : "") +
          (pr ? `<li><b>Cadastrar os produtos:</b> no painel, Meus produtos › Adicionar. Também dá para cadastrar vários de uma vez pela planilha.</li>` : "");
        try {
          await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: l.email, subject: `🏪 ${t} - ${l.nome}`,
            text: `Olá${nome ? ", " + nome : ""}! ${tx} Enquanto isso, ela aparece como "Em breve" para os clientes. Abra o painel: ${SITE}#/minha`,
            html: moldura("🏪 " + t, `<p>Olá${nome ? ", " + esc(nome) : ""}!</p><p>A loja <b>${esc(l.nome)}</b> já está cadastrada, mas ainda aparece como <b>"Em breve"</b> para os clientes. Falta pouco:</p><ul>${passos}</ul><p>Precisa de ajuda? Responda este e-mail ou chame no WhatsApp (74) 98807-9171.</p>`, "Abrir meu painel", SITE + "#/minha", "Este lembrete para assim que a loja estiver completa.") });
          await logar("loja_parada", true);
        } catch (e) { await logar("loja_parada", false, String(e)); }
      }
      return json({ ok: true, enviados: n });
    }
    // indicação: a loja indicada fez a 1ª venda -> bônus para quem indicou
    if (tipo === "indic") {
      const { data: l } = await db.from("lojas").select("id,nome,email,bonus_ate").eq("id", id).maybeSingle();
      if (!l) return json({ ok: false });
      const ind = String(b.nome || "uma loja indicada por você"), ate = l.bonus_ate ? new Date(l.bonus_ate).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";
      const t = "🎁 Você ganhou comissão de 2%", tx = `${ind} fez a primeira venda. Sua comissão fica em 2%${ate ? " até " + ate : " por 30 dias"}.`;
      const n = await enviarPush(l.id, { title: t, body: tx, url: "/#/minha", tag: "indic" });
      const s = smtp();
      if (s && l.email) {
        try {
          await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: l.email, subject: `${t} - Eita Vale`, text: `${tx} Obrigado por indicar! ${SITE}#/minha`,
            html: moldura(t, `<p>A loja <b>${esc(ind)}</b>, que você indicou, fez a primeira venda no Eita Vale.</p><p>Como prêmio, a comissão da loja <b>${esc(l.nome)}</b> fica em <b>2%</b>${ate ? " até <b>" + ate + "</b>" : " por 30 dias"}. Cada nova loja indicada que vender soma mais 30 dias.</p>`, "Abrir meu painel", SITE + "#/minha", "Continue indicando: seu link está no painel, em Indique uma loja.") });
          await logar("indic", true);
        } catch (e) { await logar("indic", false, String(e)); }
      }
      return json({ ok: true, enviados: n });
    }
    // favorito baixou de preço ou voltou ao estoque (push; sem push, e-mail)
    if (tipo === "fav") {
      const { data: p } = await db.from("produtos").select("id,titulo,fotos,loja_id,adulto").eq("id", String(b.p || "")).maybeSingle();
      if (!p || p.adulto) return json({ ok: false });
      const { data: l } = await db.from("lojas").select("nome").eq("id", p.loja_id).maybeSingle();
      const k = String(b.k || ""), de = Number(b.de || 0), por = Number(b.por || 0), tit = String(p.titulo || "Produto").slice(0, 70), loja = l?.nome || "a loja";
      const m = k === "estoque"
        ? { title: "✅ Voltou ao estoque", body: `${tit} · ${loja}. Garanta o seu antes que acabe.` }
        : { title: `🔻 Baixou de preço: ${brl(por)}`, body: `${tit} · antes ${brl(de)}. Toque para ver.` };
      const env = await enviarPushCli(id, { ...m, url: "/#/produto/" + p.id, tag: "fav-" + p.id });
      if (env > 0) return json({ ok: true, enviados: env });
      const { data: c } = await db.from("cliente_contas").select("email,nome").eq("user_id", id).maybeSingle();
      const s = smtp();
      if (!s || !c?.email) return json({ ok: true, enviados: 0 });
      const nome = String(c.nome || "").trim().split(" ")[0], link = SITE + "p/" + p.id, foto = Array.isArray(p.fotos) && p.fotos[0] ? String(p.fotos[0]) : "";
      try {
        await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: c.email, subject: `${m.title} · ${tit}`,
          text: `Olá${nome ? ", " + nome : ""}! Um produto dos seus favoritos ${k === "estoque" ? "voltou ao estoque" : "baixou de " + brl(de) + " para " + brl(por)}: ${tit} (${loja}). ${link}`,
          html: moldura(m.title, `<p>Olá${nome ? ", " + esc(nome) : ""}!</p><p>Um produto dos seus favoritos ${k === "estoque" ? "<b>voltou ao estoque</b>" : "baixou de <s>" + brl(de) + "</s> para <b>" + brl(por) + "</b>"}:</p>${foto ? `<p style="text-align:center"><img src="${esc(foto)}" alt="" width="220" style="border-radius:12px;max-width:100%"></p>` : ""}<p style="text-align:center"><b>${esc(tit)}</b><br>${esc(loja)}</p>`, "Ver produto", link, "Você recebe este aviso porque favoritou o produto. Para parar, é só tirar dos favoritos.") });
        await logar("fav_" + k, true);
      } catch (e) { await logar("fav_" + k, false, String(e)); }
      return json({ ok: true, enviados: 0, email: true });
    }
    // sacolinha esquecida (3h sem mexer, no máximo 1 por dia)
    if (tipo === "sacola") {
      const { data: sc } = await db.from("cli_sacola").select("n,loja_id,itens").eq("cliente_uid", id).maybeSingle();
      if (!sc || !sc.n) return json({ ok: false });
      const { data: l } = sc.loja_id ? await db.from("lojas").select("nome").eq("id", sc.loja_id).maybeSingle() : { data: null };
      const its = (Array.isArray(sc.itens) ? sc.itens : []) as Array<{ id: string }>;
      const { data: ps } = its.length ? await db.from("produtos").select("titulo,adulto").in("id", its.map((x) => x.id).slice(0, 20)) : { data: [] };
      const disc = (ps || []).some((x: { adulto: boolean }) => x.adulto), t1 = !disc && ps && ps[0] ? String(ps[0].titulo).slice(0, 60) : "";
      const qt = sc.n + (sc.n > 1 ? " itens" : " item"), loja = !disc && l?.nome ? " da " + l.nome : "";
      const m = { title: "🛍️ Sua sacolinha está esperando", body: `${qt}${loja}${t1 ? ": " + t1 + (its.length > 1 ? " e mais" : "") : ""}. Finalize antes que acabe.` };
      const env = await enviarPushCli(id, { ...m, url: "/#/carrinho", tag: "sacola" });
      if (env > 0) return json({ ok: true, enviados: env });
      const { data: c } = await db.from("cliente_contas").select("email,nome").eq("user_id", id).maybeSingle();
      const s = smtp();
      if (!s || !c?.email) return json({ ok: true, enviados: 0 });
      const nome = String(c.nome || "").trim().split(" ")[0];
      try {
        await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: c.email, subject: "🛍️ Você esqueceu algo na sacolinha - Eita Vale",
          text: `Olá${nome ? ", " + nome : ""}! Você deixou ${qt} na sacolinha${loja}. Finalize sua compra: ${SITE}#/carrinho`,
          html: moldura("🛍️ Sua sacolinha está esperando", `<p>Olá${nome ? ", " + esc(nome) : ""}!</p><p>Você deixou <b>${qt}</b> na sacolinha${esc(loja)}${t1 ? ", como <b>" + esc(t1) + "</b>" : ""}.</p><p>Os produtos podem acabar. Finalize enquanto ainda tem.</p>`, "Ver minha sacolinha", SITE + "#/carrinho", "Entre na sua conta para ver a sacolinha em qualquer aparelho.") });
        await logar("sacola", true);
      } catch (e) { await logar("sacola", false, String(e)); }
      return json({ ok: true, enviados: 0, email: true });
    }
    if (tipo === "cli") {
      const { data: p } = await db.from("pedidos").select("id,loja,loja_id,cliente_uid,total,frete,servico,adulto,rastreio,frete_servico,sinal_valor").eq("id", Number(id)).maybeSingle();
      if (!p || !p.cliente_uid) return json({ ok: false });
      const k = String(b.k || ""), n = p.id, sv = !!p.servico;
      if (p.adulto) p.loja = "A loja"; // pedido discreto: sem nome da loja nos avisos
      let m: { title: string; body: string; url?: string } | null = null;
      if (k === "frete") m = { title: `🚚 Frete definido · pedido nº ${n}`, body: `${p.loja}: frete ${brl(Number(p.frete))}. Total ${brl(Number(p.total))}. Toque para pagar.` };
      else if (k === "confirmado") m = { title: `✅ ${p.loja} confirmou seu pedido nº ${n}`, body: "Seu pedido já está sendo preparado." };
      else if (k === "saiu") m = p.rastreio ? { title: `📦 Pedido nº ${n} postado${p.frete_servico ? " (" + p.frete_servico + ")" : ""}`, body: `Código de rastreio ${p.rastreio}. Toque para acompanhar.` } : { title: `🛵 Seu pedido nº ${n} saiu para entrega`, body: `${p.loja} já está a caminho.` };
      else if (k === "entregue") m = { title: sv ? `🛠️ Serviço do pedido nº ${n} realizado` : `📦 Pedido nº ${n} entregue`, body: "Confirme o recebimento e conte como foi.", url: `/#/avaliar/${n}` };
      else if (k === "pronto") m = { title: `🎁 Sua encomenda nº ${n} ficou pronta`, body: `${p.loja} terminou sua encomenda. Toque para acompanhar.` };
      else if (k === "restante") m = { title: sv ? `✅ Serviço do pedido nº ${n} concluído` : `🎁 Sua encomenda nº ${n} ficou pronta`, body: `Pague o restante (${brl(Number(p.total) - Number(p.sinal_valor || 0))}) em até 3 dias para receber. Toque para pagar.` };
      else if (k === "restante_lembrete") m = { title: `⏰ Falta 1 dia · pedido nº ${n}`, body: `Pague o restante (${brl(Number(p.total) - Number(p.sinal_valor || 0))}) até amanhã. Sem o pagamento, o pedido é cancelado e o sinal não é devolvido.` };
      else if (k === "rest_expirou") m = { title: `Pedido nº ${n} cancelado`, body: "O prazo para pagar o restante terminou. Conforme a regra aceita na compra, o sinal ficou com a loja." };
      else if (k === "atraso") m = { title: `⏰ Encomenda nº ${n} atrasada`, body: "Passou 2 dias da data prevista. Você pode aguardar ou pedir o cancelamento em Meus pedidos." };
      else if (k === "cancelado") m = { title: `Pedido nº ${n} cancelado`, body: "Se você já pagou, o valor volta pelo Mercado Pago." };
      else if (k === "avaliar") m = { title: "⭐ Como foi sua compra?", body: `Avalie o pedido nº ${n} na ${p.loja}. Leva menos de 1 minuto.`, url: `/#/avaliar/${n}` };
      else if (k === "chat" && p.adulto) m = { title: "💬 Nova mensagem no seu pedido", body: `Pedido nº ${n}: toque para ver.` };
      else if (k === "chat") {
        const { data: ms } = await db.from("pedido_msgs").select("texto").eq("pedido_id", n).eq("de", "loja").order("id", { ascending: false }).limit(1);
        m = { title: `💬 ${p.loja} respondeu`, body: String((ms && ms[0] && ms[0].texto) || "Nova mensagem no chat do pedido.").slice(0, 120) };
      }
      if (!m) return json({ ok: false });
      const env = await enviarPushCli(p.cliente_uid, { ...m, tag: "ped-" + n + "-" + k });
      return json({ ok: true, enviados: env });
    }
    if (tipo === "cli_pergunta") {
      const { data: q } = await db.from("perguntas").select("id,cliente_uid,produto,anonima,status").eq("id", id).maybeSingle();
      if (!q || !q.cliente_uid || q.status !== "respondida") return json({ ok: false });
      const env = await enviarPushCli(q.cliente_uid, { title: "💬 Sua pergunta foi respondida", body: q.anonima ? "Toque para ver a resposta da loja." : `Sobre: ${String(q.produto || "produto").slice(0, 80)}`, url: "/#/pedidos", tag: "perg-" + q.id });
      return json({ ok: true, enviados: env });
    }
    if (tipo === "comunicado") {
      const { data: c } = await db.from("comunicados").select("id,publico,titulo,texto,push,apagado").eq("id", id).maybeSingle();
      if (!c || !c.push || c.apagado) return json({ ok: false });
      const m = { title: `📬 ${String(c.titulo).slice(0, 80)}`, body: String(c.texto || "Toque para ler a mensagem do Eita Vale.").slice(0, 120), tag: "com-" + c.id };
      let n = 0;
      if (c.publico === "lojas") {
        const { data: ds } = await db.from("comunicado_dest").select("loja_id").eq("com_id", c.id).not("loja_id", "is", null);
        for (const d of (ds || []) as Array<{ loja_id: string }>) n += await enviarPush(d.loja_id, { ...m, url: "/#/minha" });
      } else if (c.publico === "clientes") {
        const subs = await pegarTudo<{ cliente_uid: string }>((a, z) => db.from("push_cli").select("cliente_uid").range(a, z));
        for (const u of [...new Set(subs.map((s) => s.cliente_uid))]) n += await enviarPushCli(u, { ...m, url: "/#/pedidos" });
      }
      return json({ ok: true, enviados: n });
    }
    // resumo semanal para o administrador (segunda às 8h)
    if (tipo === "resumo_admin") {
      const s = smtp();
      if (!s) return json({ ok: false });
      const { data: d } = await db.rpc("resumo_admin_dados");
      if (!d) return json({ ok: false });
      const L = (a: unknown) => (Array.isArray(a) ? a : []) as string[];
      const caixa = (n: string, t: string) => `<td style="background:#f3f1ea;border-radius:10px;padding:12px 4px;text-align:center;width:33%"><div style="font-size:18px;font-weight:bold;color:#16363F;white-space:nowrap">${esc(n)}</div><div style="font-size:12px;color:#666">${esc(t)}</div></td>`;
      const lista = (t: string, a: string[], vazio: string) => `<p style="margin:14px 0 4px;font-weight:bold">${t}</p>` + (a.length ? `<ul style="margin:0;padding-left:18px;color:#333">${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p style="margin:0;color:#666">${vazio}</p>`);
      const corpo = `<p style="margin:6px 0">Bom dia! Assim foi a última semana no Eita Vale:</p>
<table role="presentation" style="width:100%;border-spacing:8px;margin:8px -8px"><tr>${caixa(String(d.pedidos), d.pedidos === 1 ? "pedido pago" : "pedidos pagos")}${caixa(brl(Number(d.vendido)), "vendido")}${caixa(String(d.visitas), "visitantes")}</tr></table>
<p style="margin:6px 0">👥 Clientes novos com conta: <b>${d.clientes_novos}</b> · 🚨 Pedidos parados há mais de 1 dia: <b>${d.atencao}</b></p>
${lista("🏪 Lojas novas", L(d.lojas_novas), "Nenhuma loja nova nesta semana.")}${lista("⏳ Lojas paradas (Em breve)", L(d.paradas), "Nenhuma loja parada. 🎉")}${lista("🔎 O que os clientes mais buscaram", L(d.buscas), "Nenhuma busca registrada.")}`;
      try {
        await s.t.sendMail({ from: `Eita Vale <${s.user}>`, to: s.user, subject: `📊 Resumo da semana do Eita Vale · ${d.pedidos} pedido(s) · ${brl(Number(d.vendido))}`,
          text: `Resumo da semana: ${d.pedidos} pedidos pagos, ${brl(Number(d.vendido))} vendido, ${d.visitas} visitantes, ${d.clientes_novos} clientes novos, ${d.atencao} pedidos parados. Lojas paradas: ${L(d.paradas).join(", ") || "nenhuma"}. Buscas: ${L(d.buscas).join(", ") || "nenhuma"}. ${SITE}#/admin`,
          html: moldura("📊 Resumo da semana", corpo, "Abrir o painel", SITE + "#/admin", "Enviado toda segunda-feira às 8h.") });
        await logar("resumo_admin", true);
      } catch (e) { await logar("resumo_admin", false, String(e)); }
      return json({ ok: true });
    }
    if (tipo === "resumo") return json({ ok: true, ...(await resumoSemanal()) });
    if (tipo === "resumo_teste") return json({ ok: true, ...(await resumoSemanal(id, String(b.para || ""))) });
    return json({ erro: "Tipo inválido." }, 400);
  } catch (e) {
    console.error(String(e));
    return json({ ok: false }, 200);
  }
});
