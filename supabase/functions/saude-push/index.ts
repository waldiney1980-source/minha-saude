// Minha Saúde — lembretes de água por notificação push (Web Push + VAPID).
//
// Chamadas:
//   cron (a cada 30 min): POST {acao:"enviar"} com cabeçalho x-cron-segredo
//   app (usuário logado): POST {acao:"testar"} com Authorization: Bearer <jwt>
//
// Chaves VAPID e segredo do cron ficam na tabela sau_config (apenas service role).

import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rest(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`REST ${path}: ${res.status} ${texto.slice(0, 200)}`);
  return texto ? JSON.parse(texto) : null;
}

let config: Record<string, string> | null = null;
async function carregarConfig() {
  if (config) return config;
  const linhas = await rest("sau_config?select=chave,valor");
  config = Object.fromEntries(linhas.map((l: any) => [l.chave, l.valor]));
  return config;
}

/** Início do dia atual em Brasília (UTC-3, sem horário de verão), em ISO UTC. */
function inicioDoDiaBRT(): string {
  const brt = new Date(Date.now() - 3 * 3600e3);
  const inicio = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()) + 3 * 3600e3;
  return new Date(inicio).toISOString();
}

async function aguaHoje(userId: string): Promise<number> {
  const linhas = await rest(
    `sau_agua?select=ml&user_id=eq.${userId}&quando=gte.${encodeURIComponent(inicioDoDiaBRT())}`,
  );
  return (linhas || []).reduce((s: number, l: any) => s + (Number(l.ml) || 0), 0);
}

async function enviarPara(sub: any, titulo: string, corpo: string, cfg: Record<string, string>) {
  try {
    await webpush.sendNotification(
      sub.subscription,
      JSON.stringify({ title: titulo, body: corpo, tag: "agua" }),
      {
        vapidDetails: {
          subject: "mailto:waldiney1980@gmail.com",
          publicKey: cfg.vapid_publica,
          privateKey: cfg.vapid_privada,
        },
        TTL: 1800,
      },
    );
    return true;
  } catch (e: any) {
    const status = e?.statusCode || 0;
    if (status === 404 || status === 410) {
      // inscrição morta (app desinstalado etc.) — remove
      await rest(`sau_push?id=eq.${sub.id}`, { method: "DELETE" }).catch(() => {});
    }
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* corpo vazio */ }

  const cfg = await carregarConfig();

  /* -------- cron: lembretes conforme janela e intervalo de cada aparelho -------- */
  if (body.acao === "enviar") {
    if (req.headers.get("x-cron-segredo") !== cfg.cron_segredo) {
      return json({ error: "Não autorizado." }, 401);
    }
    const brt = new Date(Date.now() - 3 * 3600e3);
    const hora = brt.getUTCHours();
    const minutos = hora * 60 + brt.getUTCMinutes();

    const subs = await rest("sau_push?select=*&ativo=is.true");
    let enviados = 0;
    const consumoPorUsuario: Record<string, number> = {};

    for (const s of subs || []) {
      if (hora < s.hora_inicio || hora >= s.hora_fim) continue;
      const desdeInicio = minutos - s.hora_inicio * 60;
      if (desdeInicio < 0 || desdeInicio % Math.max(30, s.intervalo_min) >= 30) continue;

      if (!(s.user_id in consumoPorUsuario)) {
        consumoPorUsuario[s.user_id] = await aguaHoje(s.user_id).catch(() => 0);
      }
      const ml = consumoPorUsuario[s.user_id];
      const corpo = ml > 0
        ? `Você já registrou ${ml} ml hoje. Um copo agora mantém o ritmo!`
        : "Nenhum registro hoje ainda. Que tal começar com um copo de água?";
      if (await enviarPara(s, "Hora de beber água 💧", corpo, cfg)) enviados++;
    }
    return json({ ok: true, enviados, avaliados: (subs || []).length });
  }

  /* -------- app: notificação de teste para o próprio usuário -------- */
  if (body.acao === "testar") {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Entre novamente no aplicativo." }, 401);
    const resU = await fetch(`${URL_BASE}/auth/v1/user`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${token}` },
    });
    if (!resU.ok) return json({ error: "Sessão inválida." }, 401);
    const usuario = await resU.json();

    const subs = await rest(`sau_push?select=*&user_id=eq.${usuario.id}`);
    if (!subs?.length) return json({ error: "Nenhum aparelho inscrito ainda." }, 400);
    let enviados = 0;
    for (const s of subs) {
      if (await enviarPara(s, "Teste de lembrete 💧", "As notificações estão funcionando!", cfg)) enviados++;
    }
    return json({ ok: true, enviados });
  }

  return json({ error: "Ação desconhecida." }, 400);
});
