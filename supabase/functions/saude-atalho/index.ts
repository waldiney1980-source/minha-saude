// Minha Saúde — recebe dados do app Saúde / Apple Watch enviados pelo app Atalhos.
//
// Aceita o corpo em qualquer um destes formatos (o Atalhos varia conforme a versão):
//   JSON              {"token":"...","passos":"8432","exercicio_min":"42"}
//   linhas texto      token: xxx / passos: 8432 / exercicio: 42        (":" ou "=")
//   formulário        token=xxx&passos=8432
//   query na URL      ?token=xxx&passos=8432
//
// Campos reconhecidos (com sinônimos em português e inglês):
//   token · data · passos · distancia_km · fc_repouso · fc_media · sono
//   energia_repouso · calorias (energia ativa) · exercicio_min · de_pe_h · peso_kg
//   treinos: [{tipo, duracao_min, calorias, inicio}]
//
// Extras: { teste: true } interpreta e responde sem gravar nada.
// Todo envio fica registrado em sau_debug (sem o token) para diagnóstico.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
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

/* ---------------- leitura tolerante do corpo ---------------- */

/** "Frequência Cardíaca em Repouso" → "frequencia_cardiaca_em_repouso" */
const normalizarChave = (k: string) =>
  String(k).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Sinônimos aceitos → nome interno do campo. */
const ALIAS: Record<string, string> = {
  token: "token", codigo: "token", code: "token", chave: "token",
  data: "data", dia: "data", date: "data",

  passos: "passos", steps: "passos", contagem_de_passos: "passos",
  numero_de_passos: "passos", step_count: "passos",

  distancia: "distancia_km", distancia_km: "distancia_km", distance: "distancia_km",
  distancia_de_caminhada_corrida: "distancia_km", walking_running_distance: "distancia_km",
  km: "distancia_km",

  fc_repouso: "fc_repouso", frequencia_cardiaca_em_repouso: "fc_repouso",
  frequencia_cardiaca_de_repouso: "fc_repouso", resting_heart_rate: "fc_repouso",
  batimentos_em_repouso: "fc_repouso",

  fc_media: "fc_media", frequencia_cardiaca: "fc_media", frequencia_cardiaca_media: "fc_media",
  heart_rate: "fc_media", batimentos: "fc_media",

  sono: "sono", sono_min: "sono", horas_de_sono: "sono", tempo_de_sono: "sono",
  sleep: "sono", analise_do_sono: "sono",

  energia_repouso: "energia_repouso", energia_em_repouso: "energia_repouso",
  energia_repouso_kcal: "energia_repouso", resting_energy: "energia_repouso",
  calorias_em_repouso: "energia_repouso", energia_basal: "energia_repouso",

  calorias: "energia_ativa", energia_ativa: "energia_ativa", energia_em_movimento: "energia_ativa",
  movimento: "energia_ativa", active_energy: "energia_ativa", calorias_ativas: "energia_ativa",
  calorias_gastas: "energia_ativa", energia_ativa_kcal: "energia_ativa",

  exercicio: "exercicio_min", exercicio_min: "exercicio_min", minutos_de_exercicio: "exercicio_min",
  exercise: "exercicio_min", exercise_minutes: "exercicio_min", tempo_de_exercicio: "exercicio_min",

  de_pe: "de_pe_h", de_pe_h: "de_pe_h", horas_em_pe: "de_pe_h", stand: "de_pe_h",
  horas_de_pe: "de_pe_h",

  peso: "peso_kg", peso_kg: "peso_kg", weight: "peso_kg", massa_corporal: "peso_kg",

  treinos: "treinos", workouts: "treinos",
  tipo: "tipo", duracao_min: "duracao_min", duracao: "duracao_min", inicio: "inicio",
  teste: "teste", test: "teste", resumo_diario: "resumo_diario",
};

/** Aplica os sinônimos e descarta o que não reconhece. */
function mapear(bruto: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bruto)) {
    const campo = ALIAS[normalizarChave(k)];
    if (!campo) continue;
    if (v === null || v === undefined) continue;
    const s = typeof v === "string" ? v.trim() : v;
    if (s === "" || s === "-") continue;           // campo vazio do Atalhos
    if (out[campo] === undefined) out[campo] = s;
  }
  return out;
}

/** "token: abc" / "passos = 8432" / "passos 8432" → objeto. */
function deLinhas(texto: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const linha of texto.split(/\r?\n/)) {
    const l = linha.trim();
    if (!l) continue;
    const m = l.match(/^([^:=]{2,60}?)\s*[:=]\s*(.*)$/);
    if (m) { out[m[1]] = m[2]; continue; }
    const m2 = l.match(/^([A-Za-zÀ-ÿ_ ]{2,40}?)\s+([\d.,:]+.*)$/);
    if (m2) out[m2[1]] = m2[2];
  }
  return out;
}

/** Junta query da URL + corpo, em qualquer formato. */
async function lerEntrada(req: Request): Promise<{ dados: Record<string, unknown>; bruto: string; tipo: string }> {
  const url = new URL(req.url);
  const daQuery: Record<string, unknown> = {};
  url.searchParams.forEach((v, k) => { daQuery[k] = v; });

  let bruto = "";
  let doCorpo: Record<string, unknown> = {};
  const tipo = req.headers.get("content-type") || "";

  if (req.method !== "GET") {
    bruto = await req.text();
    const t = bruto.trim();
    if (t) {
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          const j = JSON.parse(t);
          doCorpo = Array.isArray(j) ? { treinos: j } : j;
        } catch { doCorpo = deLinhas(t); }
      } else if (/^[^=&\s]+=[^=]*(&|$)/.test(t) && !t.includes("\n")) {
        const p = new URLSearchParams(t);
        p.forEach((v, k) => { doCorpo[k] = v; });
      } else {
        doCorpo = deLinhas(t);
      }
    }
  }
  return { dados: { ...daQuery, ...doCorpo }, bruto, tipo };
}

/* ---------------- conversões ---------------- */

/** Número a partir de "512", "512 kcal", "1.234 cal", "8.432 passos", "76,4 kg". */
function paraNumero(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, "").trim();
  if (!s || s === "-") return null;
  const virgula = s.lastIndexOf(","), ponto = s.lastIndexOf(".");
  if (virgula > -1 && ponto > -1) {
    s = virgula > ponto ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (virgula > -1) {
    s = s.length - virgula - 1 <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (ponto > -1 && s.length - ponto - 1 === 3) {
    s = s.replace(/\./g, ""); // separador de milhar
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Minutos a partir de "45", "45 min", "00:45:12", "1 h 20 min", 2700 (segundos). */
function paraMinutos(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  const hms = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hms) {
    const h = Number(hms[1]), m = Number(hms[2]), seg = Number(hms[3] || 0);
    return hms[3] ? Math.round(h * 60 + m + seg / 60) : Math.round(h * 60 + m);
  }
  const hm = s.match(/(\d+(?:[.,]\d+)?)\s*h(?:oras?|rs?)?\.?\s*(?:e\s*)?(\d+)?\s*(?:min|m)?/i);
  if (hm) return Math.round(parseFloat(hm[1].replace(",", ".")) * 60 + Number(hm[2] || 0));
  const n = paraNumero(s);
  if (n == null) return 0;
  if (/seg|sec/i.test(s)) return Math.round(n / 60);
  if (n > 600) return Math.round(n / 60); // provavelmente veio em segundos
  return Math.round(n);
}

/** Sono: "7:12", "7 h 12 min", "7,5" (horas) ou "432" (minutos). */
function paraSono(v: unknown): number {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  if (/[:h]/i.test(s)) return paraMinutos(s);
  const n = paraNumero(s);
  if (n == null) return 0;
  return n <= 24 ? Math.round(n * 60) : Math.round(n);
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

const inteiro = (n: number | null) => (n == null ? null : Math.round(n));

/* ---------------- entrada ---------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "Método não permitido." }, 405);
  }

  const { dados: cru, bruto, tipo } = await lerEntrada(req);
  const d = mapear(cru);

  const token = String(d.token || "").trim();
  const semToken = { ...d } as Record<string, unknown>;
  delete semToken.token;

  // registro de diagnóstico: sempre, mesmo quando o token falha (nunca guarda o token)
  const registrar = (userId: string | null, extra: Record<string, unknown>) =>
    rest("sau_debug", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        payload: {
          content_type: tipo,
          metodo: req.method,
          bruto: (token ? bruto.split(token).join("«token»") : bruto).slice(0, 4000),
          chaves_recebidas: Object.keys(cru),
          interpretado: semToken,
          ...extra,
        },
      }),
      headers: { Prefer: "return=minimal" },
    }).catch(() => {});

  // Sem token não há gravação; devolvemos como o envio foi lido, o que serve de
  // diagnóstico do atalho (é só o eco do que o próprio remetente mandou).
  if (token.length < 16) {
    await registrar(null, { erro: "token ausente" });
    return json({
      error: "Código de conexão ausente ou inválido.",
      chaves_recebidas: Object.keys(cru),
      interpretado: semToken,
    }, 401);
  }

  const perfis = await rest(`sau_perfil?select=user_id&atalho_token=eq.${encodeURIComponent(token)}`);
  if (!perfis?.length) {
    await registrar(null, { erro: "token não reconhecido" });
    return json({ error: "Código de conexão não reconhecido." }, 401);
  }
  const userId = perfis[0].user_id;
  const teste = String(d.teste ?? "").toLowerCase() === "true" || d.teste === true;
  const data = paraData(d.data);

  /* -------- resumo do dia (anéis + amostras do app Saúde) -------- */
  const diario: Record<string, unknown> = {};
  if (d.passos !== undefined) diario.passos = inteiro(paraNumero(d.passos));
  if (d.distancia_km !== undefined) diario.distancia_km = paraNumero(d.distancia_km);
  if (d.fc_repouso !== undefined) diario.fc_repouso = inteiro(paraNumero(d.fc_repouso));
  if (d.fc_media !== undefined) diario.fc_media = inteiro(paraNumero(d.fc_media));
  if (d.sono !== undefined) diario.sono_min = paraSono(d.sono) || null;
  if (d.energia_repouso !== undefined) diario.energia_repouso_kcal = paraNumero(d.energia_repouso);
  if (d.energia_ativa !== undefined) diario.energia_ativa_kcal = paraNumero(d.energia_ativa);
  if (d.exercicio_min !== undefined) diario.exercicio_min = paraMinutos(d.exercicio_min) || null;
  if (d.de_pe_h !== undefined) diario.de_pe_h = inteiro(paraNumero(d.de_pe_h));

  // campos que vieram, mas sem valor numérico algum, não valem gravação
  const temDiario = Object.values(diario).some((v) => v != null && v !== 0);

  const exercicioMin = paraMinutos(d.exercicio_min);
  const energiaAtiva = paraNumero(d.energia_ativa);

  const resposta: Record<string, unknown> = { ok: true, data, teste, gravado: {} };
  const gravado = resposta.gravado as Record<string, unknown>;

  if (temDiario && !teste) {
    await rest("sau_diario?on_conflict=user_id,data", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, data, ...diario, atualizado_em: new Date().toISOString() }),
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    });
  }
  if (temDiario) gravado.resumo_do_dia = diario;

  /* -------- anéis também viram a "Atividade do dia", que alimenta as telas -------- */
  if (exercicioMin || energiaAtiva) {
    const uid = `resumo|${data}`;
    const linha = {
      user_id: userId,
      tipo: "Atividade do dia",
      data,
      duracao_min: exercicioMin,
      calorias: energiaAtiva,
      obs: "Apple Watch",
      uid,
    };
    if (!teste) {
      const existentes = await rest(
        `sau_atividades?select=id&user_id=eq.${userId}&uid=eq.${encodeURIComponent(uid)}&limit=1`,
      );
      if (existentes?.length) {
        await rest(`sau_atividades?id=eq.${existentes[0].id}`, {
          method: "PATCH", body: JSON.stringify(linha), headers: { Prefer: "return=minimal" },
        });
      } else {
        await rest("sau_atividades", {
          method: "POST", body: JSON.stringify(linha), headers: { Prefer: "return=minimal" },
        });
      }
    }
    gravado.atividade_do_dia = { exercicio_min: exercicioMin, calorias: energiaAtiva };
  }

  /* -------- treinos individuais (lista), sem duplicar -------- */
  const brutos: any[] = Array.isArray(d.treinos)
    ? d.treinos
    : (d.tipo || d.inicio ? [d] : []);

  const linhas = brutos.map((t) => {
    const tt = mapear(t as Record<string, unknown>);
    const tipoTreino = String(tt.tipo || "Treino").trim().slice(0, 60) || "Treino";
    const inicio = String(tt.inicio || "").trim();
    return {
      user_id: userId,
      tipo: tipoTreino,
      data: paraData(inicio),
      duracao_min: paraMinutos(tt.duracao_min),
      calorias: paraNumero(tt.energia_ativa),
      obs: "Apple Watch",
      uid: inicio ? `${inicio}|${tipoTreino}` : null,
    };
  }).filter((l) => l.duracao_min > 0);

  let inseridos = 0, ignorados = 0;
  if (linhas.length) {
    const uids = linhas.map((l) => l.uid).filter(Boolean) as string[];
    let existentes = new Set<string>();
    if (uids.length) {
      const q = uids.map((u) => `"${u.replace(/"/g, "")}"`).join(",");
      const rows = await rest(
        `sau_atividades?select=uid&user_id=eq.${userId}&uid=in.(${encodeURIComponent(q).replace(/%2C/g, ",")})`,
      );
      existentes = new Set((rows || []).map((r: any) => r.uid));
    }
    const novos = linhas.filter((l) => !l.uid || !existentes.has(l.uid));
    ignorados = linhas.length - novos.length;
    if (novos.length && !teste) {
      await rest("sau_atividades", {
        method: "POST", body: JSON.stringify(novos), headers: { Prefer: "return=minimal" },
      });
    }
    inseridos = novos.length;
    gravado.treinos = { inseridos, ignorados };
  }

  /* -------- peso: uma vez por dia -------- */
  const peso = paraNumero(d.peso_kg);
  if (peso && peso > 20 && peso < 400) {
    const jaTem = await rest(
      `sau_medidas?select=id&user_id=eq.${userId}&data=eq.${data}&peso_kg=not.is.null&limit=1`,
    );
    if (!jaTem?.length) {
      if (!teste) {
        await rest("sau_medidas", {
          method: "POST",
          body: JSON.stringify({ user_id: userId, data, peso_kg: peso, obs: "Apple Watch" }),
          headers: { Prefer: "return=minimal" },
        });
      }
      gravado.peso_kg = peso;
    }
  }

  const nada = !Object.keys(gravado).length;
  if (!nada && !teste) {
    await rest(`sau_perfil?user_id=eq.${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ atalho_sync_em: new Date().toISOString() }),
      headers: { Prefer: "return=minimal" },
    }).catch(() => {});
  }

  await registrar(userId, { gravado, nada });

  const partes: string[] = [];
  if (diario.passos) partes.push(`${diario.passos} passos`);
  if (diario.distancia_km) partes.push(`${diario.distancia_km} km`);
  if (exercicioMin) partes.push(`${exercicioMin} min de exercício`);
  if (energiaAtiva) partes.push(`${Math.round(energiaAtiva)} kcal ativas`);
  if (diario.energia_repouso_kcal) partes.push(`${Math.round(Number(diario.energia_repouso_kcal))} kcal em repouso`);
  if (diario.fc_repouso) partes.push(`FC repouso ${diario.fc_repouso}`);
  if (diario.fc_media) partes.push(`FC média ${diario.fc_media}`);
  if (diario.sono_min) partes.push(`${Math.floor(Number(diario.sono_min) / 60)}h${String(Number(diario.sono_min) % 60).padStart(2, "0")} de sono`);
  if (inseridos) partes.push(`${inseridos} treino(s)`);
  if (gravado.peso_kg) partes.push(`${gravado.peso_kg} kg`);

  resposta.resumo = nada
    ? "Nada foi reconhecido no envio — confira os nomes dos campos no atalho."
    : `${teste ? "Teste — nada gravado. Entendi: " : "Recebido: "}${partes.join(" · ")}`;
  if (nada) resposta.chaves_recebidas = Object.keys(cru);

  return json(resposta);
});
