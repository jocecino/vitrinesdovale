import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";
import { Buffer } from "node:buffer";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SITE = "https://valeshop-sobradinho.vercel.app/";
const CONTATO = "valeshopsobradinho@gmail.com";
const WPP = "(74) 98807-9171";
const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Documentos enviados à loja que pede cadastro (publicados no site em /docs)
const DOCS = [
  { arq: "politicas-de-pagamento.pdf", nome: "Políticas de Pagamento", desc: "comissão, prazos, frete e devoluções" },
  { arq: "taxas-do-mercado-pago.pdf", nome: "Taxas do Mercado Pago", desc: "quanto o Mercado Pago cobra e quanto sobra para a loja" },
  { arq: "como-funciona-o-frete.pdf", nome: "Como funciona o frete", desc: "formas de entrega e como informar o frete a combinar" },
  { arq: "manual-do-lojista.pdf", nome: "Manual do Lojista", desc: "como usar o painel da loja" },
  { arq: "como-funciona-a-vitrine.pdf", nome: "Como funciona a Vitrine", desc: "o caminho do cliente até a compra" },
  { arq: "termos-e-privacidade.pdf", nome: "Termos de Uso e Privacidade", desc: "regras da plataforma e LGPD" },
];

const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function registrar(acao: string, ok: boolean, erro?: string) {
  try { await db.from("email_log").insert({ acao, ok, erro: erro ? erro.slice(0, 400) : null }); } catch (_) { /* ignore */ }
}

function smtp() {
  const user = Deno.env.get("GMAIL_USER");
  const pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) return null;
  return { user: user.trim(), t: nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: user.trim(), pass: pass.replace(/\s+/g, "") } }) };
}

async function enviar(acao: string, to: string, assunto: string, titulo: string, texto: string, codigo: string) {
  const s = smtp();
  if (!s) { await registrar(acao, false, "SEM_CONFIG"); throw new Error("SEM_CONFIG"); }
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:20px">
<h2 style="margin:0 0 12px">${esc(titulo)}</h2><p>${esc(texto)}</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:bold;background:#f3f3f3;padding:14px;text-align:center;border-radius:8px">${esc(codigo)}</p>
<p style="color:#666;font-size:13px">O código vale 30 minutos. Se você não pediu, ignore este e-mail.</p>
<p style="color:#999;font-size:12px">ValeShop Sobradinho</p></div>`;
  try {
    await s.t.sendMail({
      from: `ValeShop Sobradinho <${s.user}>`, to, subject: assunto,
      text: `${titulo}\n\n${texto}\n\nCódigo: ${codigo}\n\nO código vale 30 minutos. Se você não pediu, ignore este e-mail.`, html,
    });
    await registrar(acao, true);
  } catch (e) {
    await registrar(acao, false, String(e));
    throw e;
  }
}

// e-mail de aviso com botão (pedido novo / avaliação / loja nova / aviso de produto)
async function enviarAviso(acao: string, to: string, assunto: string, titulo: string, linhas: string[], botao: string, link: string, rodape: string) {
  const s = smtp();
  if (!s) { await registrar(acao, false, "SEM_CONFIG"); throw new Error("SEM_CONFIG"); }
  const html = `<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto;padding:20px">
<h2 style="margin:0 0 12px">${esc(titulo)}</h2>${linhas.map((l) => `<p style="margin:6px 0">${esc(l)}</p>`).join("")}
<p style="text-align:center;margin:22px 0"><a href="${esc(link)}" style="background:#16363F;color:#E9D08A;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:8px;display:inline-block">${esc(botao)}</a></p>
<p style="color:#666;font-size:13px">${esc(rodape)}</p><p style="color:#999;font-size:12px">ValeShop Sobradinho</p></div>`;
  try {
    await s.t.sendMail({ from: `ValeShop Sobradinho <${s.user}>`, to, subject: assunto, text: `${titulo}\n\n${linhas.join("\n")}\n\n${botao}: ${link}\n\n${rodape}`, html });
    await registrar(acao, true);
  } catch (e) {
    await registrar(acao, false, String(e));
    throw e;
  }
}

// e-mail para a loja que acabou de pedir cadastro: confirmação + os documentos (anexos e links)
async function enviarBoasVindas(to: string, loja: string, responsavel: string) {
  const s = smtp();
  if (!s) { await registrar("loja_boas_vindas", false, "SEM_CONFIG"); throw new Error("SEM_CONFIG"); }
  const anexos: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  for (const d of DOCS) {
    try {
      const r = await fetch(SITE + "docs/" + d.arq);
      if (r.ok) anexos.push({ filename: "ValeShop - " + d.nome + ".pdf", content: Buffer.from(new Uint8Array(await r.arrayBuffer())), contentType: "application/pdf" });
      else console.error("doc", d.arq, r.status);
    } catch (e) { console.error("doc", d.arq, String(e)); }
  }
  const ola = responsavel ? `Olá, ${responsavel}!` : "Olá!";
  const lis = DOCS.map((d) => `<li style="margin:6px 0"><a href="${SITE}docs/${d.arq}" style="color:#16363F;font-weight:bold">${esc(d.nome)}</a> <span style="color:#666">— ${esc(d.desc)}</span></li>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:20px;color:#1F2A2E">
<div style="background:#16363F;color:#E9D08A;padding:16px 18px;border-radius:10px 10px 0 0;font-weight:bold;letter-spacing:.04em">VALESHOP SOBRADINHO</div>
<div style="border:1px solid #E6E0D2;border-top:0;border-radius:0 0 10px 10px;padding:18px">
<h2 style="margin:0 0 10px;color:#16363F">Recebemos o cadastro da sua loja!</h2>
<p>${esc(ola)} O cadastro da loja <b>${esc(loja)}</b> foi enviado e está <b>em análise</b> pela administração da ValeShop. A resposta chega no WhatsApp informado.</p>
<p><b>Próximo passo:</b> depois da aprovação, entre no painel da loja e conecte a sua conta do Mercado Pago em <i>Loja › Receber pelo Mercado Pago</i>. A loja só aparece na vitrine depois dessa conexão.</p>
<p>Para você conhecer como a plataforma funciona, enviamos em anexo os documentos da ValeShop. Também é possível abrir pelo navegador:</p>
<ul style="padding-left:18px">${lis}</ul>
<p style="text-align:center;margin:22px 0"><a href="${SITE}#/minha" style="background:#16363F;color:#E9D08A;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:8px;display:inline-block">Abrir o painel da loja</a></p>
<p style="color:#666;font-size:13px">Dúvidas? Fale com a administração pelo WhatsApp ${WPP} ou pelo e-mail ${CONTATO}.</p></div>
<p style="color:#999;font-size:12px;text-align:center">ValeShop Sobradinho · ${SITE.replace(/^https:\/\//, "").replace(/\/$/, "")}</p></div>`;
  const text = `Recebemos o cadastro da sua loja!\n\n${ola} O cadastro da loja ${loja} foi enviado e está em análise pela administração da ValeShop. A resposta chega no WhatsApp informado.\n\nPróximo passo: depois da aprovação, entre no painel da loja e conecte a sua conta do Mercado Pago em Loja > Receber pelo Mercado Pago.\n\nDocumentos da ValeShop (também em anexo):\n${DOCS.map((d) => `- ${d.nome}: ${SITE}docs/${d.arq}`).join("\n")}\n\nDúvidas? WhatsApp ${WPP} ou ${CONTATO}.`;
  try {
    await s.t.sendMail({ from: `ValeShop Sobradinho <${s.user}>`, to, subject: "Recebemos o cadastro da sua loja – ValeShop", text, html, attachments: anexos });
    await registrar("loja_boas_vindas", true, anexos.length < DOCS.length ? `anexos ${anexos.length}/${DOCS.length}` : undefined);
  } catch (e) {
    await registrar("loja_boas_vindas", false, String(e));
    throw e;
  }
}

const brl = (n: number) => "R$ " + Number(n || 0).toFixed(2).replace(".", ",");

const mask = (e: string) => {
  const [u, d] = e.split("@");
  return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "***") + "@" + d;
};

// acha o WhatsApp (já normalizado) da conta a partir do e-mail
async function telPorEmail(tipo: string, email: string): Promise<string | null> {
  const tabela = tipo === "loja" ? "lojas" : "cliente_contas";
  const campo = tipo === "loja" ? "whatsapp" : "tel";
  const { data } = await db.from(tabela).select(campo).eq("email", email.trim().toLowerCase()).limit(1);
  const r = data && (data[0] as Record<string, string> | undefined);
  return r ? r[campo] : null;
}

async function emailsAdmin(): Promise<string[]> {
  const { data } = await db.from("admins").select("user_id");
  const out: string[] = [];
  for (const a of (data || []) as Array<{ user_id: string }>) {
    const { data: u } = await db.auth.admin.getUserById(a.user_id);
    const e = u?.user?.email;
    if (e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !e.endsWith("vitrinesdovale.app") && !e.endsWith("valeshop.app")) out.push(e);
  }
  return out;
}

async function notificar(tipo: string, id: string) {
  if (tipo === "aviso_produto") {
    const { data: a } = await db.from("avisos_loja").select("loja_id,produto_titulo,motivo,obs,acao").eq("id", id).maybeSingle();
    if (!a) return;
    const { data: l } = await db.from("lojas").select("email,nome").eq("id", a.loja_id).maybeSingle();
    if (!l || !l.email) return;
    if (a.acao === "loja_suspensa" || a.acao === "loja_reativada") {
      const sus = a.acao === "loja_suspensa";
      await enviarAviso(a.acao, l.email, sus ? `🔒 Sua loja foi suspensa - ValeShop` : `🟢 Sua loja voltou ao ar - ValeShop`,
        sus ? "Sua loja foi suspensa pela administração" : "Sua loja voltou ao ar!",
        sus ? [`Loja: ${l.nome}`, `Motivo: ${a.motivo || "-"}`, "Enquanto estiver suspensa, a loja e os produtos não aparecem na vitrine e não recebem pedidos novos. Pedidos já feitos continuam normalmente.", "Somente a administração pode reativar a loja. Fale conosco para resolver.", `💬 WhatsApp da administração: ${WPP}`]
            : [`Loja: ${l.nome}`, "A administração reativou a sua loja. Ela já aparece na vitrine e pode receber pedidos novamente."],
        sus ? "Falar no WhatsApp" : "Abrir meu painel", sus ? "https://wa.me/5574988079171" : SITE + "#/minha", sus ? `Dúvidas? Fale com a administração pelo WhatsApp ${WPP} ou pelo e-mail ${CONTATO}.` : `Dúvidas? Fale com a administração pelo e-mail ${CONTATO}.`);
      return;
    }
    const rem = a.acao === "removido", pau = a.acao === "pausado";
    await enviarAviso("aviso_produto", l.email, `⚠️ Aviso da administração sobre seu produto - ValeShop`,
      rem ? "Um produto seu foi removido" : pau ? "Um produto seu foi pausado" : "Atenção: seu produto pode violar nossas políticas",
      [`Produto: ${a.produto_titulo || "-"}`, `Motivo: ${a.motivo || "-"}`, a.obs ? `Observação da administração: ${a.obs}` : "",
        rem ? "O produto foi removido da plataforma. Se achar que foi um engano, fale com a administração." : pau ? "O produto saiu da vitrine. Corrija o anúncio e fale com a administração para pedir a reativação." : "Corrija o anúncio o quanto antes para evitar que ele seja pausado ou removido."].filter(Boolean),
      "Abrir meu painel", SITE + "#/minha", `Dúvidas? Fale com a administração pelo e-mail ${CONTATO}.`);
    return;
  }
  if (tipo === "campanha_nova" || tipo === "campanha_teste") {
    const tst = tipo === "campanha_teste";
    const { data: c } = await db.from("campanhas").select("nome,tag,inicio,fim,modo,desc_pct,desc_max,regra_com,com_pct,ativo,status,teste_loja").eq("id", id).maybeSingle();
    if (!c || (!tst && !c.ativo) || (tst && (!c.teste_loja || c.status === "lancada"))) return;
    const dt = (v: string) => new Date(v).toLocaleString("pt-BR", { timeZone: "America/Bahia", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const desc = c.modo === "fixo" ? `${Number(c.desc_pct)}% de desconto` : `de ${Number(c.desc_pct)}% a ${Number(c.desc_max)}% de desconto (você escolhe)`;
    const com = c.regra_com === "fixo" ? `${Number(c.com_pct)}% fixo` : c.regra_com === "extra" ? `tabela normal + ${Number(c.com_pct)}%` : "tabela normal";
    const q = db.from("lojas").select("email,nome");
    const { data: ls } = tst ? await q.eq("id", c.teste_loja) : await q.eq("status", "ativa");
    for (const l of (ls || []) as Array<{ email: string; nome: string }>) {
      if (!l.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(l.email)) continue;
      try {
        await enviarAviso(tipo, l.email, `${tst ? "🧪 TESTE · " : ""}${c.tag} Nova campanha na ValeShop: ${c.nome}`, `${tst ? "🧪 TESTE · " : ""}${c.tag} Sua loja está convidada: ${c.nome}`,
          [`Período: ${dt(c.inicio)} até ${dt(c.fim)}`, `Desconto: ${desc}`, `Comissão nas vendas da campanha: ${com}`,
            "Os produtos que participam ganham a tag, o preço com desconto e uma aba própria na vitrine.",
            "Para participar, abra o painel da loja em Minha conta › Minha loja › 🎉 Campanhas e escolha os produtos.",
            ...(tst ? ["Este é um aviso de TESTE: só a sua loja recebeu. Na vitrine, a campanha aparece só para você até a administração lançá-la."] : [])],
          "Escolher produtos", SITE + "#/minha", `Dúvidas? Fale com a administração pelo WhatsApp ${WPP}.`);
      } catch (e) { console.error("campanha", l.email, String(e)); }
    }
    return;
  }
  if (tipo === "loja_nova") {
    const { data: l } = await db.from("lojas").select("nome,responsavel,sobrenome,bairro,categoria,status,email").eq("id", id).maybeSingle();
    if (!l || l.status !== "pendente") return;
    for (const to of await emailsAdmin()) {
      await enviarAviso("loja_nova", to, `🏪 Nova loja aguardando aprovação: ${l.nome}`, "Uma loja nova se cadastrou!",
        [`Loja: ${l.nome}`, `Responsável: ${[l.responsavel, l.sobrenome].filter(Boolean).join(" ")}`, `Bairro: ${l.bairro || "-"}${l.categoria ? " · " + l.categoria : ""}`, "Confira os dados e aprove ou recuse o cadastro."],
        "Ver cadastro para aprovar", SITE + "#/admin/lojas", "A loja só aparece na vitrine depois de aprovada.");
    }
    // a loja recebe a confirmação com os documentos (falha aqui não atrapalha o aviso da administração)
    if (l.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(l.email)) {
      try { await enviarBoasVindas(l.email, l.nome, String(l.responsavel || "").trim().split(" ")[0]); } catch (e) { console.error("boas-vindas", String(e)); }
    }
    return;
  }
  const pid = Number(id);
  const { data: p } = await db.from("pedidos").select("id,loja,loja_id,cliente,cliente_uid,itens,total,frete,status,tipo,servico,ag_pref,preco_def,direto,frete_combinar,frete_def,pg_status").eq("id", pid).maybeSingle();
  if (!p) return;
  if (tipo === "pedido_novo") {
    const { data: l } = await db.from("lojas").select("email").eq("id", p.loja_id).maybeSingle();
    if (!l || !l.email) return;
    const its = (Array.isArray(p.itens) ? p.itens : []) as Array<Record<string, unknown>>;
    const resumo = its.slice(0, 5).map((i) => `${Number(i.qtd || i.q || 1)}x ${String(i.titulo || "Produto")}`).join(", ") + (its.length > 5 ? "…" : "");
    const sv = !!p.servico;
    await enviarAviso("pedido_novo", l.email, sv ? `✂️ Novo pedido de serviço nº ${p.id} - ValeShop` : `🛒 Novo pedido nº ${p.id} - ValeShop`, sv ? "Você recebeu um pedido de serviço!" : "Você recebeu um novo pedido!",
      [`Pedido nº ${p.id} de ${p.cliente || "cliente"}.`, resumo ? `${sv ? "Serviço" : "Itens"}: ${resumo}` : "", sv ? `Data sugerida: ${p.ag_pref || "-"}` : "", sv && !p.preco_def ? "Valor: a combinar (informe ao aceitar)" : `Total: ${brl(Number(p.total))}`, sv ? "Abra o painel, combine pelo chat e toque em Aceitar e agendar." : p.direto ? "✅ Pedido já PAGO pelo Mercado Pago. Abra o painel e toque em Confirmar e preparar." : (p.frete_combinar && !p.frete_def) ? "🚚 O cliente quer combinar o frete: responda no chat do pedido e toque em Definir frete." : "Abra o painel para aceitar o pedido e combinar a entrega."].filter(Boolean),
      "Abrir meus pedidos", SITE + "#/minha", p.direto ? "Você tem até 36 horas para confirmar. Sem confirmação, o valor é devolvido automaticamente ao cliente." : "Responda rápido: pedidos novos que ficam sem resposta expiram automaticamente.");
  } else if (tipo === "frete_definido") {
    if (!p.cliente_uid) return;
    const { data: c } = await db.from("cliente_contas").select("email,nome").eq("user_id", p.cliente_uid).maybeSingle();
    if (!c || !c.email) return;
    await enviarAviso("frete_definido", c.email, `🚚 Frete definido - pague seu pedido nº ${p.id}`, `Olá${c.nome ? ", " + String(c.nome).split(" ")[0] : ""}! A loja definiu o frete`,
      [`A loja ${p.loja || ""} definiu o frete do pedido nº ${p.id}: ${brl(Number(p.frete))}.`, `Total a pagar: ${brl(Number(p.total))}.`, "Pague pelo Mercado Pago (Pix, cartão ou saldo) em até 24 horas para garantir os produtos."],
      "Pagar agora", `${SITE}#/pedidos`, "Dúvidas? Converse com a loja pelo chat do pedido.");
  } else if (tipo === "entregue") {
    if (p.status !== "entregue" || !p.cliente_uid) return;
    const { data: c } = await db.from("cliente_contas").select("email,nome").eq("user_id", p.cliente_uid).maybeSingle();
    if (!c || !c.email) return;
    const sv = !!p.servico;
    await enviarAviso("entregue", c.email, sv ? `✂️ Serviço do pedido nº ${p.id} realizado - avalie!` : `📦 Seu pedido nº ${p.id} foi entregue - avalie!`, `Olá${c.nome ? ", " + String(c.nome).split(" ")[0] : ""}! ${sv ? "Seu serviço foi realizado" : "Seu pedido foi entregue"}`,
      [`A loja ${p.loja || ""} marcou o pedido nº ${p.id} como ${sv ? "serviço realizado" : "entregue"}.`, "Conte pra gente o que achou: dê sua nota, escreva um comentário e, se quiser, envie uma foto do produto.", "⏳ Você tem 7 dias para avaliar. Depois desse prazo a avaliação não fica mais disponível."],
      "Avaliar meu pedido", `${SITE}#/avaliar/${p.id}`, "Se você ainda não recebeu o pedido, fale com a loja pelo chat na sua conta.");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Método inválido." }, 405);
  let b: Record<string, string>;
  try { b = await req.json(); } catch (_) { return json({ erro: "Pedido inválido." }, 400); }
  const dev = String(b.dev || "").slice(0, 60);

  try {
    if (b.acao === "notificar") {
      const k = req.headers.get("x-notify-key") || "";
      const { data: cfg } = await db.from("app_cfg").select("valor").eq("chave", "notify_key").maybeSingle();
      if (!k || !cfg || cfg.valor !== k) return json({ erro: "Não autorizado." }, 401);
      const id = String(b.id || "");
      const tp = String(b.tipo);
      const uu = (tp === "loja_nova" || tp === "aviso_produto" || tp === "campanha_nova" || tp === "campanha_teste");
      if (!id || !["pedido_novo", "entregue", "frete_definido", "loja_nova", "aviso_produto", "campanha_nova", "campanha_teste"].includes(tp) || (!uu && !Number(id)) || (uu && !/^[0-9a-f-]{36}$/i.test(id))) return json({ erro: "Pedido inválido." }, 400);
      try { await notificar(tp, id); } catch (e) { console.error("notificar", String(e)); return json({ ok: false }, 200); }
      return json({ ok: true });
    }

    if (b.acao === "verif") {
      const tipo = b.tipo === "cliente" ? "cliente" : "loja";
      const email = String(b.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) return json({ erro: "Digite um e-mail válido." }, 400);
      if (await telPorEmail(tipo, email)) return json({ erro: "Este e-mail já está cadastrado. Use outro e-mail." }, 400);
      const { data: cod, error } = await db.rpc("email_codigo_criar", { p_email: email, p_dev: dev });
      if (error) return json({ erro: error.message }, 400);
      try {
        await enviar("verif", email, "Seu código de confirmação - ValeShop", "Confirme seu e-mail", "Use o código abaixo para confirmar o seu e-mail na ValeShop Sobradinho:", cod as string);
      } catch (e) {
        console.error("smtp", String(e));
        return json({ erro: String(e).includes("SEM_CONFIG") ? "O envio de e-mail ainda não foi configurado." : "Não foi possível enviar o e-mail agora. Confira o endereço e tente de novo." }, 503);
      }
      return json({ ok: true });
    }

    if (b.acao === "senha") {
      const tipo = b.tipo === "cliente" ? "cliente" : "loja";
      let tel = String(b.tel || "").trim();
      if (tel.includes("@")) {
        const t = await telPorEmail(tipo, tel);
        if (!t) return json({ erro: "Não encontramos uma conta com este e-mail." }, 400);
        tel = t;
      }
      const { data, error } = await db.rpc("senha_pedir_email", { p_tipo: tipo, p_tel: tel, p_dev: dev });
      if (error) return json({ erro: error.message }, 400);
      const r = data as { chave: string; via: string; email?: string; nome?: string; codigo?: string };
      if (r.via === "email" && r.email && r.codigo) {
        try {
          await enviar("senha", r.email, "Código para criar nova senha - ValeShop", "Nova senha", `Olá${r.nome ? ", " + r.nome : ""}! Use o código abaixo para criar uma nova senha na ValeShop Sobradinho:`, r.codigo);
          return json({ chave: r.chave, via: "email", email: mask(r.email) });
        } catch (e) {
          console.error("smtp", String(e));
          await db.from("senha_pedidos").update({ codigo_hash: null, codigo_ate: null }).eq("chave", r.chave);
          return json({ chave: r.chave, via: "admin", aviso: "Não conseguimos enviar o e-mail agora. A administração vai enviar o código pelo WhatsApp." });
        }
      }
      return json({ chave: r.chave, via: "admin" });
    }

    if (b.acao === "login") {
      // entrar com e-mail + senha (a conta de acesso usa o WhatsApp por trás)
      const tipo = b.tipo === "cliente" ? "cliente" : "loja";
      const id = String(b.id || "").trim().toLowerCase();
      const senha = String(b.senha || "");
      const erroGen = { erro: "E-mail ou senha incorretos." };
      if (!id.includes("@") || !senha) return json(erroGen, 401);
      const desde = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const { count } = await db.from("login_falhas").select("id", { count: "exact", head: true }).in("chave", ["e:" + id, "d:" + dev]).gte("ts", desde);
      if ((count || 0) >= 16) return json({ erro: "Muitas tentativas. Aguarde alguns minutos." }, 429);
      const tel = await telPorEmail(tipo, id);
      let sess = null;
      if (tel) {
        const anon = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
        const dominio = tipo === "loja" ? "@lojas.vitrinesdovale.app" : "@clientes.valeshop.app";
        const r = await anon.auth.signInWithPassword({ email: tel + dominio, password: senha });
        if (!r.error && r.data.session) sess = r.data.session;
      }
      if (!sess) {
        await db.from("login_falhas").insert([{ chave: "e:" + id }, { chave: "d:" + dev }]);
        return json(erroGen, 401);
      }
      return json({ access_token: sess.access_token, refresh_token: sess.refresh_token });
    }
    return json({ erro: "Ação inválida." }, 400);
  } catch (e) {
    console.error(String(e));
    await registrar("erro", false, String(e));
    return json({ erro: "Erro inesperado. Tente de novo." }, 500);
  }
});
