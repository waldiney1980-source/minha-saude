// Minha Saúde — IA do aplicativo (Supabase Edge Function, Deno).
// O JWT do usuário é verificado pela plataforma.
//
// Ações:
//   { acao: "refeicao", imagem, mediaType, descricao? }  → itens e calorias da foto
//   { acao: "avaliacao", dados }                          → avaliação de saúde em texto
//
// Provedor escolhido pelo segredo configurado, na ordem:
//   GOOGLE_API_KEY      Google Gemini — tem camada gratuita (recomendado)
//   ANTHROPIC_API_KEY   Anthropic Claude — pago por uso
// Opcional: SAUDE_MODEL fixa o id do modelo.

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

/* ---------------- prompts ---------------- */

const PROMPT_REFEICAO = [
  "Você é um nutricionista experiente em comida brasileira.",
  "A foto mostra uma refeição. Identifique cada alimento visível, estime a porção",
  "(em medidas caseiras, ex.: '2 colheres de arroz', '1 filé médio') e as calorias de cada item.",
  "Considere preparos típicos do Brasil (arroz, feijão, farofa, frituras etc.).",
  "Se não tiver certeza do alimento, dê a interpretação mais provável e reduza a confiança.",
  "Se a imagem não mostrar comida, devolva itens vazio, total 0 e explique em 'observacao'.",
  "Responda em português do Brasil.",
].join(" ");

const SCHEMA_REFEICAO = {
  type: "object",
  properties: {
    itens: {
      type: "array",
      items: {
        type: "object",
        properties: {
          nome: { type: "string" },
          quantidade: { type: "string" },
          calorias: { type: "number" },
          proteinas_g: { type: "number" },
          carboidratos_g: { type: "number" },
          gorduras_g: { type: "number" },
        },
        required: ["nome", "quantidade", "calorias"],
      },
    },
    total_calorias: { type: "number" },
    confianca: { type: "number" },
    observacao: { type: "string" },
  },
  required: ["itens", "total_calorias", "confianca", "observacao"],
};

const PROMPT_AVALIACAO = [
  "Você é um assistente de saúde que ajuda uma pessoa leiga a entender seus próprios dados.",
  "Receberá um JSON com: perfil (idade, sexo, altura, peso, nível de atividade, objetivo),",
  "exames de laboratório com faixas de referência, medidas (peso e pressão ao longo do tempo),",
  "resumo alimentar (calorias médias por dia, distribuição) e atividades físicas recentes.",
  "Escreva uma avaliação clara em português do Brasil, formatada em Markdown, com as seções:",
  "## Visão geral — 2 ou 3 frases sobre o estado geral.",
  "## Exames — comente cada exame fora da faixa de referência e o que costuma significar; cite também os que estão bem.",
  "## Peso e alimentação — IMC, tendência do peso, saldo calórico frente ao objetivo declarado.",
  "## Atividade física — compare com a recomendação da OMS (150 min moderados/semana).",
  "## Recomendações — lista curta e prática (alimentação, atividade, sono, acompanhamento).",
  "Regras: seja direto e acolhedor; não invente dados que não recebeu; aponte incertezas;",
  "NUNCA dê diagnóstico fechado nem prescreva medicamentos ou dosagens;",
  "sempre que algo estiver fora da faixa, oriente a conversar com um médico.",
  "Termine com a linha: '⚠️ Esta análise é informativa e não substitui consulta médica.'",
].join(" ");

/* ---------------- descoberta do modelo do Gemini ---------------- */

let modelosCache: string[] | null = null;

function pontuar(nome: string): number {
  const v = nome.match(/(\d+(?:\.\d+)?)/);
  let p = v ? parseFloat(v[1]) : 0;
  if (/lite/i.test(nome)) p -= 0.5;
  if (/(preview|exp)/i.test(nome)) p -= 0.25;
  return p;
}

async function modelosDisponiveis(apiKey: string): Promise<string[]> {
  const fixo = Deno.env.get("SAUDE_MODEL");
  if (fixo) return [fixo];
  if (modelosCache) return modelosCache;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Erro ${res.status} ao listar modelos.`);

  const lista: string[] = (data.models || [])
    .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m: any) => String(m.name).replace(/^models\//, ""))
    .filter((n: string) => /gemini/i.test(n) && !/(tts|audio|embedding|live|image|native|thinking)/i.test(n));

  if (!lista.length) throw new Error("Nenhum modelo compatível disponível para esta chave do Google.");

  lista.sort((a, b) => pontuar(b) - pontuar(a));
  const flash = lista.filter((n) => /flash/i.test(n));
  const resto = lista.filter((n) => !/flash/i.test(n));
  modelosCache = [...flash, ...resto].slice(0, 6);
  return modelosCache;
}

/* ---------------- Google Gemini ---------------- */

async function chamarGemini(
  apiKey: string,
  model: string,
  partes: unknown[],
  schema: unknown | null,
  maxTokens: number,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const generationConfig: Record<string, unknown> = { temperature: 0.2, maxOutputTokens: maxTokens };
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: partes }], generationConfig }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Erro ${res.status}`);
  const saida = data?.candidates?.[0]?.content?.parts?.filter((p: any) => p.text).map((p: any) => p.text).join("");
  if (!saida) throw new Error("Resposta vazia do modelo.");
  return saida;
}

async function comGemini(
  apiKey: string,
  partes: unknown[],
  schema: unknown | null,
  maxTokens: number,
): Promise<{ texto: string; model: string }> {
  const candidatos = await modelosDisponiveis(apiKey);
  const erros: string[] = [];
  for (const model of candidatos) {
    try {
      const texto = await chamarGemini(apiKey, model, partes, schema, maxTokens);
      modelosCache = [model, ...candidatos.filter((c) => c !== model)];
      return { texto, model };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      erros.push(`${model}: ${msg}`);
      if (/API key|quota|RESOURCE_EXHAUSTED|PERMISSION_DENIED/i.test(msg)) break;
    }
  }
  throw new Error(erros.join(" | "));
}

/** Converte o schema (JSON Schema) para o formato do Gemini. */
function schemaGemini(s: any): any {
  if (!s || typeof s !== "object") return s;
  const tipo = String(s.type || "").toUpperCase();
  const out: any = { type: tipo };
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = schemaGemini(v);
    if (s.required) out.required = s.required;
  }
  if (s.items) out.items = schemaGemini(s.items);
  return out;
}

/* ---------------- Anthropic Claude ---------------- */

async function comClaude(
  apiKey: string,
  conteudo: unknown[],
  schema: unknown | null,
  maxTokens: number,
): Promise<{ texto: string; model: string }> {
  const { default: Anthropic } = await import("npm:@anthropic-ai/sdk@0.70.1");
  const client = new Anthropic({ apiKey });
  const model = Deno.env.get("SAUDE_MODEL") || "claude-sonnet-5";

  const req: any = {
    model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: conteudo }],
  };
  if (schema) {
    req.output_config = { effort: "low", format: { type: "json_schema", schema } };
  }
  const response = await client.messages.create(req);
  if (response.stop_reason === "refusal") throw new Error("O modelo recusou a análise.");
  const bloco = response.content.find((b: any) => b.type === "text");
  if (!bloco || bloco.type !== "text") throw new Error("Resposta vazia do modelo.");
  return { texto: bloco.text, model };
}

/* ---------------- entrada ---------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const googleKey = Deno.env.get("GOOGLE_API_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

  if (req.method === "GET") {
    return json({ ok: true, google: !!googleKey, anthropic: !!anthropicKey });
  }
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);
  if (!googleKey && !anthropicKey) {
    return json({ error: "Nenhuma chave de IA configurada (GOOGLE_API_KEY ou ANTHROPIC_API_KEY)." }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corpo inválido." }, 400);
  }

  try {
    if (body.acao === "refeicao") {
      const base64 = String(body.imagem || "").replace(/^data:image\/\w+;base64,/, "");
      if (!base64) return json({ error: "Envie a imagem em base64." }, 400);
      const mediaType = /^(png|jpeg|webp)$/.test(body.mediaType) ? body.mediaType : "jpeg";
      const extra = body.descricao ? ` Contexto do usuário sobre a refeição: "${String(body.descricao).slice(0, 300)}".` : "";

      let r: { texto: string; model: string };
      if (googleKey) {
        r = await comGemini(googleKey, [
          { inline_data: { mime_type: `image/${mediaType}`, data: base64 } },
          { text: PROMPT_REFEICAO + extra },
        ], schemaGemini(SCHEMA_REFEICAO), 4096);
      } else {
        r = await comClaude(anthropicKey!, [
          { type: "image", source: { type: "base64", media_type: `image/${mediaType}`, data: base64 } },
          { type: "text", text: PROMPT_REFEICAO + extra },
        ], SCHEMA_REFEICAO, 4096);
      }
      return json({ ok: true, model: r.model, resultado: JSON.parse(r.texto) });
    }

    if (body.acao === "avaliacao") {
      const dados = JSON.stringify(body.dados || {}).slice(0, 60_000);
      const texto = `${PROMPT_AVALIACAO}\n\nDados do usuário:\n${dados}`;

      let r: { texto: string; model: string };
      if (googleKey) {
        r = await comGemini(googleKey, [{ text: texto }], null, 8192);
      } else {
        r = await comClaude(anthropicKey!, [{ type: "text", text: texto }], null, 8192);
      }
      return json({ ok: true, model: r.model, avaliacao: r.texto });
    }

    return json({ error: "Ação desconhecida. Use 'refeicao' ou 'avaliacao'." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
