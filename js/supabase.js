// Minha Saúde — acesso ao Supabase (Auth + PostgREST + Edge Function), sem SDK.

const URL_BASE = 'https://mhqhbnfbfrfsckhcvzis.supabase.co';
const CHAVE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ocWhibmZiZnJmc2NraGN2emlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MDk0NjUsImV4cCI6MjEwMDM4NTQ2NX0.47aA6k6SbiXX0iCRasf4Lpd2wP7xuW0U03DP_Q0wzbU';
const GUARDA = 'saude.sessao';

let sessao = null;
try { sessao = JSON.parse(localStorage.getItem(GUARDA) || 'null'); } catch { sessao = null; }

export const temSessao = () => !!(sessao && sessao.access_token);
export const usuario = () => (sessao ? { email: sessao.email, id: sessao.userId } : null);

function guardar(data) {
  if (!data || !data.access_token) throw new Error('Resposta de autenticação inválida.');
  sessao = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    email: (data.user && data.user.email) || '',
    userId: (data.user && data.user.id) || '',
  };
  localStorage.setItem(GUARDA, JSON.stringify(sessao));
  return sessao;
}

async function raw(path, { method = 'GET', body, headers = {}, auth = true, timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const h = { apikey: CHAVE, 'Content-Type': 'application/json', ...headers };
  if (auth && sessao && sessao.access_token) h.Authorization = 'Bearer ' + sessao.access_token;
  try {
    const res = await fetch(URL_BASE + path, {
      method, headers: h, signal: ctrl.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && (data.error_description || data.msg || data.message || data.error || data.hint)) || `Erro ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function pedir(path, opts = {}) {
  if (sessao && sessao.expires_at && sessao.expires_at - 60000 < Date.now() && sessao.refresh_token) {
    await renovar().catch(() => {});
  }
  try {
    return await raw(path, opts);
  } catch (e) {
    if (e.status === 401 && sessao) {
      await renovar();
      return raw(path, opts);
    }
    throw e;
  }
}

export async function entrar(email, senha) {
  const data = await raw('/auth/v1/token?grant_type=password', {
    method: 'POST', auth: false, body: { email, password: senha },
  });
  return guardar(data);
}

export async function criarConta(email, senha) {
  const data = await raw('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password: senha } });
  if (!data || !data.access_token) {
    const err = new Error('Conta criada. Confirme o e-mail recebido e depois entre normalmente.');
    err.code = 'confirmar-email';
    throw err;
  }
  return guardar(data);
}

async function renovar() {
  if (!sessao || !sessao.refresh_token) throw new Error('Sessão expirada. Entre novamente.');
  const data = await raw('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', auth: false, body: { refresh_token: sessao.refresh_token },
  });
  return guardar(data);
}

export async function sair() {
  try { await raw('/auth/v1/logout', { method: 'POST' }); } catch { /* sessão local basta */ }
  sessao = null;
  localStorage.removeItem(GUARDA);
}

/* ---------------- dados ---------------- */

export const listar = (tabela, query = '') =>
  pedir(`/rest/v1/${tabela}?${query}`);

export const inserir = (tabela, linha) =>
  pedir(`/rest/v1/${tabela}`, {
    method: 'POST', body: linha,
    headers: { Prefer: 'return=representation' },
  }).then((r) => (Array.isArray(r) ? r[0] : r));

export const alterar = (tabela, id, patch, chave = 'id') =>
  pedir(`/rest/v1/${tabela}?${chave}=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', body: patch,
    headers: { Prefer: 'return=representation' },
  }).then((r) => (Array.isArray(r) ? r[0] : r));

export const apagar = (tabela, id) =>
  pedir(`/rest/v1/${tabela}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Perfil é 1 linha por usuário: upsert por user_id. */
export const salvarPerfil = (dados) =>
  pedir('/rest/v1/sau_perfil', {
    method: 'POST', body: dados,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  }).then((r) => (Array.isArray(r) ? r[0] : r));

/** Edge Function de IA (foto de refeição e avaliação de saúde). */
export const ia = (payload, timeout = 90000) =>
  pedir('/functions/v1/saude-ia', { method: 'POST', body: payload, timeout });
