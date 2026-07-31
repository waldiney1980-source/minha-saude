// Minha Saúde — recebe treinos/peso do app Atalhos (Apple Watch / app Saúde).
//
// POST { token, treinos: [{tipo, duracao_min, calorias, inicio}], peso_kg? }
// ou um treino único no corpo: { token, tipo, duracao_min, calorias, inicio }.
// O token pessoal é gerado no app (Perfil → Apple Watch) e fica em sau_perfil.
//
// Tolerante a formatos do Atalhos: "45 min", "00:45:12", "350 kcal",
// datas localizadas "31/07/2026 07:12" etc.

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

/** Minutos a partir de "45", "45 min", "00:45:12", 2700 (segundos) etc. */
function paraMinutos(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  const hms = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hms) {
    const h = Number(hms[1]), m = Number(hms[2]), seg = Number(hms[3] || 0);
    return hms[3] ? Math.round(h * 60 + m + seg / 60) : Math.round(h * 60 + m);
  }
  const n = parseFloat(s.replace(",", "."));
  if (!Number.isFinite(n)) return 0;
  if (/seg|sec|^s$/i.test(s.replace(String(n), ""))) return Math.round(n / 60);
  if (n > 600) return Math.round(n / 60); // provavelmente veio em segundos
  return Math.round(n);
}

function paraNumero(v: unknown): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/\./g, (m, i, s0) => (String(s0).includes(",") ? "" : m)).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Data (AAAA-MM-DD, dia de Brasília) a partir de vários formatos. */
function paraData(v: unknown): string {
  const s = String(v || "").trim();
  let t = Date.parse(s);
  if (Number.isNaN(t)) {
    const br = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (br) t = Date.parse(`${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}T12:00:00-03:00`);
  }
  if (Number.isNaN(t) || !t) t = Date.now();
  const brt = new Date(t - 3 * 3600e3);
  return brt.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Corpo inválido." }, 400); }

  const token = String(body.token || "").trim();
  if (token.length < 16) return json({ error: "Código de conexão ausente ou inválido." }, 401);

  const perfis = await rest(`sau_perfil?select=user_id&atalho_token=eq.${encodeURIComponent(token)}`);
  if (!perfis?.length) return json({ error: "Código de conexão não reconhecido." }, 401);
  const userId = perfis[0].user_id;

  const brutos: any[] = Array.isArray(body.treinos)
    ? body.treinos
    : (body.tipo || body.inicio ? [body] : []);

  const linhas = brutos.map((t) => {
    const tipo = String(t.tipo || "Treino").trim().slice(0, 60) || "Treino";
    const inicio = String(t.inicio || "").trim();
    return {
      user_id: userId,
      tipo,
      data: paraData(inicio),
      duracao_min: paraMinutos(t.duracao_min ?? t.duracao),
      calorias: paraNumero(t.calorias),
      obs: "Apple Watch",
      uid: (inicio ? `${inicio}|${tipo}` : null),
    };
  }).filter((l) => l.duracao_min > 0);

  // dedupe: ignora treinos cujo uid já foi importado
  let inseridos = 0, ignorados = 0;
  if (linhas.length) {
    const uids = linhas.map((l) => l.uid).filter(Boolean) as string[];
    let existentes = new Set<string>();
    if (uids.length) {
      const q = uids.map((u) => `"${u.replace(/"/g, '')}"`).join(",");
      const rows = await rest(`sau_atividades?select=uid&user_id=eq.${userId}&uid=in.(${encodeURIComponent(q).replace(/%2C/g, ",")})`);
      existentes = new Set((rows || []).map((r: any) => r.uid));
    }
    const novos = linhas.filter((l) => !l.uid || !existentes.has(l.uid));
    ignorados = linhas.length - novos.length;
    if (novos.length) {
      await rest("sau_atividades", {
        method: "POST", body: JSON.stringify(novos),
        headers: { Prefer: "return=minimal" },
      });
      inseridos = novos.length;
    }
  }

  // peso (opcional): registra 1x por dia
  let pesoRegistrado = false;
  const peso = paraNumero(body.peso_kg);
  if (peso && peso > 20 && peso < 400) {
    const hoje = paraData("");
    const jaTem = await rest(`sau_medidas?select=id&user_id=eq.${userId}&data=eq.${hoje}&peso_kg=not.is.null&limit=1`);
    if (!jaTem?.length) {
      await rest("sau_medidas", {
        method: "POST",
        body: JSON.stringify({ user_id: userId, data: hoje, peso_kg: peso, obs: "Apple Watch" }),
        headers: { Prefer: "return=minimal" },
      });
      pesoRegistrado = true;
    }
  }

  return json({ ok: true, inseridos, ignorados, peso_registrado: pesoRegistrado });
});
