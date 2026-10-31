import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";
import webpush from "npm:web-push@3.6.7";

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const SITE = "https://valeshop-sobradinho.vercel.app/";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
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
  webpush.setVapidDetails(sub || "mailto:valeshopsobradinho@gmail.com", pub, priv);
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
<p style="color:#666;font-size:13px">${esc(rodape)}</p><p style="color:#999;font-size:12px">ValeShop Sobradinho</p></div>`;
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
      await s.t.sendMail({ from: `ValeShop Sobradinho <${s.user}>`, to: dest, subject: `${para ? "[TESTE] " : ""}📊 Seu resumo da semana - ${l.nome}`,
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
    if (tipo === "campanha_nova") {
      const { data: c } = await db.from("campanhas").select("id,nome,tag,ativo").eq("id", id).maybeSingle();
      if (!c || !c.ativo) return json({ ok: false });
      const { data: ls } = await db.from("lojas").select("id").eq("status", "ativa");
      let n = 0;
      for (const l of (ls || []) as Array<{ id: string }>) {
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
      const n = await enviarPush(m.loja_id, { title: "🛟 O ValeShop respondeu seu suporte", body: String(m.texto || "").slice(0, 100), url: "/#/minha", tag: "suporte-" + m.id });
      return json({ ok: true, enviados: n });
    }
    if (tipo === "suporte_lojista") {
      const { data: m } = await db.from("suporte_msgs").select("id,loja_id,texto").eq("id", Number(id)).maybeSingle();
      if (!m) return json({ ok: false });
      const { data: l } = await db.from("lojas").select("nome").eq("id", m.loja_id).maybeSingle();
      const s = smtp();
      if (s) {
        try {
          await s.t.sendMail({ from: `ValeShop Sobradinho <${s.user}>`, to: s.user, subject: `🛟 Suporte: mensagem de ${l?.nome || "loja"}`,
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
          await s.t.sendMail({ from: `ValeShop Sobradinho <${s.user}>`, to: l.email, subject: "🟢 Sua loja voltou ao ar - ValeShop",
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
        await s.t.sendMail({ from: `ValeShop Sobradinho <${s.user}>`, to: c.email,
          subject: ult ? `⏰ Último dia para avaliar sua compra na ${p.loja}` : `⭐ Como foi sua compra na ${p.loja}?`,
          text: `Olá${nome ? ", " + nome : ""}! ${ult ? "Faltam poucos dias para avaliar" : "Conte como foi"} o seu pedido nº ${p.id} na ${p.loja}. Leva menos de 1 minuto: ${link}`,
          html: moldura(ult ? "⏰ Ainda dá tempo de avaliar" : "⭐ Como foi sua compra?", `<p>Olá${nome ? ", " + esc(nome) : ""}!</p><p>Seu pedido nº <b>${p.id}</b> na <b>${esc(p.loja)}</b> foi entregue. Conte como foi: dê estrelas para o produto, o atendimento e a entrega.</p><p>Sua avaliação ajuda outros clientes de Sobradinho e faz as melhores lojas aparecerem primeiro.</p>`, "Avaliar agora", link, ult ? "Este é o último lembrete. O prazo para avaliar é de 7 dias após a entrega." : "Leva menos de 1 minuto. O prazo é de 7 dias após a entrega.") });
        await logar("avaliar_lembrete", true);
      } catch (e) { await logar("avaliar_lembrete", false, String(e)); }
      return json({ ok: true });
    }
    if (tipo === "cli") {
      const { data: p } = await db.from("pedidos").select("id,loja,loja_id,cliente_uid,total,frete,servico,adulto").eq("id", Number(id)).maybeSingle();
      if (!p || !p.cliente_uid) return json({ ok: false });
      const k = String(b.k || ""), n = p.id, sv = !!p.servico;
      if (p.adulto) p.loja = "A loja"; // pedido discreto: sem nome da loja nos avisos
      let m: { title: string; body: string; url?: string } | null = null;
      if (k === "frete") m = { title: `🚚 Frete definido · pedido nº ${n}`, body: `${p.loja}: frete ${brl(Number(p.frete))}. Total ${brl(Number(p.total))}. Toque para pagar.` };
      else if (k === "confirmado") m = { title: `✅ ${p.loja} confirmou seu pedido nº ${n}`, body: "Seu pedido já está sendo preparado." };
      else if (k === "saiu") m = { title: `🛵 Seu pedido nº ${n} saiu para entrega`, body: `${p.loja} já está a caminho.` };
      else if (k === "entregue") m = { title: sv ? `✂️ Serviço do pedido nº ${n} realizado` : `📦 Pedido nº ${n} entregue`, body: "Confirme o recebimento e conte como foi.", url: `/#/avaliar/${n}` };
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
    if (tipo === "resumo") return json({ ok: true, ...(await resumoSemanal()) });
    if (tipo === "resumo_teste") return json({ ok: true, ...(await resumoSemanal(id, String(b.para || ""))) });
    return json({ erro: "Tipo inválido." }, 400);
  } catch (e) {
    console.error(String(e));
    return json({ ok: false }, 200);
  }
});
