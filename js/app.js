// Minha Saúde — aplicativo (uma página, abas: Hoje, Exames, Evolução, Saúde, Perfil).

import * as sb from './supabase.js';

/* ============ utilidades ============ */

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const kcal = (v) => `${Math.round(Number(v) || 0)} kcal`;

const hojeISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dataLocal = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtData = (iso) => {
  if (!iso) return '—';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
};
const fmtHora = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function toast(msg, tipo = 'info') {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast toast--${tipo}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('some'); setTimeout(() => t.remove(), 400); }, 3600);
}

function modal(html, { aoAbrir } = {}) {
  const raiz = $('#modal-root');
  raiz.innerHTML = `<div class="modal"><div class="modal__caixa">${html}</div></div>`;
  const caixa = raiz.firstElementChild;
  caixa.addEventListener('click', (e) => { if (e.target === caixa) fecharModal(); });
  if (aoAbrir) aoAbrir(caixa);
  return caixa;
}
const fecharModal = () => { $('#modal-root').innerHTML = ''; };

/** Mini-renderizador de Markdown (títulos, negrito, listas, parágrafos). */
function md(texto) {
  const linhas = String(texto || '').split(/\r?\n/);
  let html = '', lista = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  for (const l of linhas) {
    const t = l.trim();
    if (/^[-*] /.test(t)) {
      if (!lista) { html += '<ul>'; lista = true; }
      html += `<li>${inline(t.slice(2))}</li>`;
      continue;
    }
    if (lista) { html += '</ul>'; lista = false; }
    if (!t) continue;
    if (t.startsWith('### ')) html += `<h4>${inline(t.slice(4))}</h4>`;
    else if (t.startsWith('## ')) html += `<h3>${inline(t.slice(3))}</h3>`;
    else if (t.startsWith('# ')) html += `<h3>${inline(t.slice(2))}</h3>`;
    else html += `<p>${inline(t)}</p>`;
  }
  if (lista) html += '</ul>';
  return html;
}

/** Redimensiona uma imagem para JPEG base64. */
function comprimir(arquivo, lado, qualidade) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(arquivo);
    img.onload = () => {
      const escala = Math.min(1, lado / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * escala);
      c.height = Math.round(img.height * escala);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', qualidade));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não consegui ler a imagem.')); };
    img.src = url;
  });
}

/* ============ estado ============ */

const st = {
  aba: 'hoje',
  perfil: null,
  medidas: [],
  exames: [],
  refeicoes: [],
  atividades: [],
  agua: [],
  clima: null,
  avaliacaoIA: localStorage.getItem('saude.avaliacao') || '',
  avaliacaoQuando: localStorage.getItem('saude.avaliacaoQuando') || '',
};

async function carregarTudo() {
  const [perfil, medidas, exames, refeicoes, atividades, agua] = await Promise.all([
    sb.listar('sau_perfil', 'select=*&limit=1'),
    sb.listar('sau_medidas', 'select=*&order=data.desc,criado_em.desc&limit=500'),
    sb.listar('sau_exames', 'select=*&order=data.desc,criado_em.desc&limit=1000'),
    sb.listar('sau_refeicoes', 'select=*&order=quando.desc&limit=800'),
    sb.listar('sau_atividades', 'select=*&order=data.desc&limit=800'),
    sb.listar('sau_agua', 'select=*&order=quando.desc&limit=1500'),
  ]);
  st.perfil = (perfil && perfil[0]) || null;
  st.medidas = medidas || [];
  st.exames = exames || [];
  st.refeicoes = refeicoes || [];
  st.atividades = atividades || [];
  st.agua = agua || [];
}

/* ============ clima e água ============ */

/** Temperatura máxima do dia (Open-Meteo), com cache diário e localização opcional. */
async function climaHoje() {
  const hoje = hojeISO();
  try {
    const cache = JSON.parse(localStorage.getItem('saude.clima') || 'null');
    if (cache && cache.dia === hoje) return cache;
  } catch { /* cache inválido */ }
  let lat = -22.9, lon = -43.2, local = 'Rio de Janeiro';
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000, maximumAge: 3600e3 }));
    lat = pos.coords.latitude; lon = pos.coords.longitude; local = 'sua região';
  } catch { /* sem localização: usa Rio */ }
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&timezone=auto&forecast_days=1`);
  const d = await r.json();
  const clima = { dia: hoje, tmax: Math.round(Number(d?.daily?.temperature_2m_max?.[0])) || null, local };
  localStorage.setItem('saude.clima', JSON.stringify(clima));
  return clima;
}

const aguaDo = (dia) => st.agua.filter((a) => dataLocal(a.quando) === dia);
const aguaHoje = () => aguaDo(hojeISO()).reduce((s, a) => s + (Number(a.ml) || 0), 0);

/** Meta de água: 35 ml/kg + calor do dia + atividade física de hoje. */
function metaAgua() {
  const p = pesoAtual() || 70;
  let ml = p * 35;
  const t = st.clima?.tmax;
  if (t != null) {
    if (t >= 32) ml += 700;
    else if (t >= 28) ml += 500;
    else if (t >= 24) ml += 250;
  }
  const minAtv = atividadesDo(hojeISO()).reduce((s, a) => s + (Number(a.duracao_min) || 0), 0);
  ml += Math.round((minAtv / 60) * 400);
  return Math.round(ml / 50) * 50;
}

function mediaAgua(nDias = 7) {
  const porDia = {};
  const limite = Date.now() - nDias * 864e5;
  for (const a of st.agua) {
    if (new Date(a.quando).getTime() < limite) continue;
    const d = dataLocal(a.quando);
    porDia[d] = (porDia[d] || 0) + (Number(a.ml) || 0);
  }
  const dias = Object.keys(porDia);
  if (!dias.length) return null;
  return dias.reduce((s, d) => s + porDia[d], 0) / dias.length;
}

/* ============ proteína ============ */

/** Meta diária de proteína (g): g/kg pelo nível de atividade, ajustada pelo objetivo. */
function metaProteina() {
  const p = pesoAtual();
  if (!p) return null;
  let fator = { sedentario: 1.0, leve: 1.2, moderado: 1.4, intenso: 1.7 }[st.perfil?.nivel_atividade] || 1.2;
  if (st.perfil?.objetivo === 'perder' || st.perfil?.objetivo === 'ganhar') fator += 0.2;
  return Math.round(p * Math.min(fator, 2.0));
}

const proteinaDo = (dia) =>
  refeicoesDo(dia).reduce((s, r) => s + (Number(r.proteinas_g) || 0), 0);

function mediaProteina(nDias = 7) {
  const porDia = {};
  const limite = Date.now() - nDias * 864e5;
  for (const r of st.refeicoes) {
    if (new Date(r.quando).getTime() < limite || r.proteinas_g == null) continue;
    const d = dataLocal(r.quando);
    porDia[d] = (porDia[d] || 0) + (Number(r.proteinas_g) || 0);
  }
  const dias = Object.keys(porDia);
  if (!dias.length) return null;
  return dias.reduce((s, d) => s + porDia[d], 0) / dias.length;
}

/* ============ cálculos de saúde ============ */

const idade = () => {
  const n = st.perfil?.nascimento;
  if (!n) return null;
  const d = new Date(n + 'T12:00');
  const hoje = new Date();
  let a = hoje.getFullYear() - d.getFullYear();
  if (hoje.getMonth() < d.getMonth() || (hoje.getMonth() === d.getMonth() && hoje.getDate() < d.getDate())) a--;
  return a;
};

const pesoAtual = () => {
  const m = st.medidas.find((x) => x.peso_kg != null);
  return m ? Number(m.peso_kg) : null;
};
const pressaoAtual = () => st.medidas.find((x) => x.pressao_sist != null) || null;

/** Altura em cm; aceita valor gravado em metros (ex.: 1,65 → 165). */
const alturaCm = () => {
  const a = num(st.perfil?.altura_cm);
  if (!a) return null;
  return a < 3 ? a * 100 : a;
};

const imc = () => {
  const p = pesoAtual(), a = alturaCm();
  if (!p || !a) return null;
  return p / ((a / 100) ** 2);
};
const classeIMC = (v) =>
  v == null ? ['—', ''] :
  v < 18.5 ? ['Abaixo do peso', 'atencao'] :
  v < 25 ? ['Peso normal', 'bom'] :
  v < 30 ? ['Sobrepeso', 'atencao'] :
  ['Obesidade', 'ruim'];

/** Taxa metabólica basal (Mifflin-St Jeor). */
function tmb() {
  const p = pesoAtual(), a = alturaCm(), i = idade(), s = st.perfil?.sexo;
  if (!p || !a || i == null || !s) return null;
  return 10 * p + 6.25 * a - 5 * i + (s === 'M' ? 5 : -161);
}
const FATOR = { sedentario: 1.2, leve: 1.375, moderado: 1.55, intenso: 1.725 };
function gastoDiario() {
  const b = tmb();
  return b ? b * (FATOR[st.perfil?.nivel_atividade] || 1.375) : null;
}
function metaCalorias() {
  if (st.perfil?.meta_calorias) return Number(st.perfil.meta_calorias);
  const g = gastoDiario();
  if (!g) return null;
  const obj = st.perfil?.objetivo || 'manter';
  return Math.round(g + (obj === 'perder' ? -500 : obj === 'ganhar' ? 300 : 0));
}

const refeicoesDo = (dia) => st.refeicoes.filter((r) => dataLocal(r.quando) === dia);
const atividadesDo = (dia) => st.atividades.filter((a) => String(a.data).slice(0, 10) === dia);
const somaCal = (lista) => lista.reduce((s, x) => s + (Number(x.calorias) || 0), 0);

/** Média de calorias/dia nos últimos n dias com registro. */
function mediaCalorias(nDias = 7) {
  const porDia = {};
  const limite = Date.now() - nDias * 864e5;
  for (const r of st.refeicoes) {
    if (new Date(r.quando).getTime() < limite) continue;
    const d = dataLocal(r.quando);
    porDia[d] = (porDia[d] || 0) + (Number(r.calorias) || 0);
  }
  const dias = Object.keys(porDia);
  if (!dias.length) return null;
  return dias.reduce((s, d) => s + porDia[d], 0) / dias.length;
}
function minutosAtividadeSemana() {
  const limite = Date.now() - 7 * 864e5;
  return st.atividades
    .filter((a) => new Date(a.data + 'T12:00').getTime() >= limite)
    .reduce((s, a) => s + (Number(a.duracao_min) || 0), 0);
}

/* ============ exames: modelos com faixas usuais ============ */

const EXAMES_MODELO = [
  { nome: 'Glicose em jejum', unidade: 'mg/dL', min: 70, max: 99 },
  { nome: 'Hemoglobina glicada (HbA1c)', unidade: '%', min: 4, max: 5.6 },
  { nome: 'Colesterol total', unidade: 'mg/dL', min: null, max: 190 },
  { nome: 'HDL', unidade: 'mg/dL', min: 40, max: null },
  { nome: 'LDL', unidade: 'mg/dL', min: null, max: 130 },
  { nome: 'Triglicerídeos', unidade: 'mg/dL', min: null, max: 150 },
  { nome: 'Creatinina', unidade: 'mg/dL', min: 0.7, max: 1.3 },
  { nome: 'TSH', unidade: 'µUI/mL', min: 0.4, max: 4.5 },
  { nome: 'Ácido úrico', unidade: 'mg/dL', min: 3.5, max: 7.2 },
  { nome: 'Vitamina D', unidade: 'ng/mL', min: 30, max: 100 },
  { nome: 'Hemoglobina', unidade: 'g/dL', min: 13, max: 17 },
  { nome: 'Ferritina', unidade: 'ng/mL', min: 30, max: 300 },
  { nome: 'Outro', unidade: '', min: null, max: null },
];

function statusExame(e) {
  const v = Number(e.valor);
  if (e.ref_min != null && v < Number(e.ref_min)) return ['Baixo', 'atencao'];
  if (e.ref_max != null && v > Number(e.ref_max)) return ['Alto', 'ruim'];
  if (e.ref_min == null && e.ref_max == null) return ['—', ''];
  return ['Normal', 'bom'];
}

/* ============ atividades: gasto por MET ============ */

const ATIVIDADES_MET = [
  ['Caminhada', 3.5], ['Corrida', 8], ['Ciclismo', 6], ['Musculação', 4],
  ['Futebol', 7], ['Futevôlei', 6.5], ['Natação', 6], ['Dança', 5],
  ['Faxina / tarefas', 3], ['Outra', 4],
];
function calAtividade(tipo, minutos) {
  const p = pesoAtual() || 75;
  const met = (ATIVIDADES_MET.find(([n]) => n === tipo) || [0, 4])[1];
  return Math.round(met * p * (minutos / 60));
}

/* ============ telas ============ */

const TITULOS = {
  hoje: ['Hoje', () => fmtData(hojeISO())],
  exames: ['Exames', () => `${st.exames.length} registro(s)`],
  evolucao: ['Evolução', () => 'peso, calorias e atividade'],
  saude: ['Minha saúde', () => 'indicadores e avaliação'],
  perfil: ['Perfil', () => sb.usuario()?.email || ''],
};

function render() {
  const [titulo, sub] = TITULOS[st.aba];
  $('#titulo').textContent = titulo;
  $('#subtitulo').textContent = sub();
  $$('.abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === st.aba));
  const v = $('#view');
  v.innerHTML = '';
  ({ hoje: telaHoje, exames: telaExames, evolucao: telaEvolucao, saude: telaSaude, perfil: telaPerfil })[st.aba](v);
}

/* ---------- Hoje ---------- */

function telaHoje(v) {
  const dia = hojeISO();
  const refs = refeicoesDo(dia).sort((a, b) => new Date(a.quando) - new Date(b.quando));
  const ats = atividadesDo(dia);
  const consumido = somaCal(refs);
  const gastoAtv = somaCal(ats);
  const meta = metaCalorias();
  const pct = meta ? Math.min(100, Math.round((consumido / meta) * 100)) : 0;
  const restante = meta ? Math.round(meta - consumido) : null;
  const protHoje = Math.round(proteinaDo(dia));
  const protMeta = metaProteina();
  const agua = aguaHoje();
  const aguaMeta = metaAgua();
  const aguaPct = Math.min(100, Math.round((agua / aguaMeta) * 100));
  const t = st.clima?.tmax;

  if (!st.clima) {
    climaHoje().then((c) => { st.clima = c; if (st.aba === 'hoje') render(); }).catch(() => {});
  }

  v.innerHTML = `
    <section class="cartao resumo">
      <div class="resumo__anel" style="--pct:${pct}">
        <div class="resumo__miolo"><b>${Math.round(consumido)}</b><span>kcal</span></div>
      </div>
      <div class="resumo__info">
        <p><b>Meta:</b> ${meta ? kcal(meta) : '<a href="#" data-ir="perfil">complete o perfil</a>'}</p>
        <p><b>Atividade:</b> ${kcal(gastoAtv)} gastos</p>
        <p><b>Proteína:</b> ${protHoje} g${protMeta ? ` de ${protMeta} g` : ''}</p>
        ${restante != null ? `<p class="${restante < 0 ? 'texto-ruim' : 'texto-bom'}">${restante >= 0 ? `Restam ${kcal(restante)}` : `${kcal(-restante)} acima da meta`}</p>` : ''}
      </div>
    </section>

    <section class="cartao">
      <header class="cartao__cab"><h2>Água 💧</h2>
        <button class="btn btn--mini btn--fantasma" id="b-lembretes">🔔 Lembretes</button>
      </header>
      <div class="agua-barra"><div class="agua-barra__cheio" style="width:${aguaPct}%"></div></div>
      <p class="agua-info"><b>${agua} ml</b> de <b>${aguaMeta} ml</b>
        ${t != null ? ` · máx. de <b>${t}°C</b> hoje${t >= 28 ? ' — dia quente, hidrate-se mais!' : ''}` : ''}</p>
      <p class="nota">Meta calculada pelo seu peso${t != null ? ', pela temperatura do dia' : ''} e pela atividade física de hoje.</p>
      <div class="agua-botoes">
        <button class="btn btn--mini" data-agua="200">+ Copo (200)</button>
        <button class="btn btn--mini" data-agua="300">+ Copo (300)</button>
        <button class="btn btn--mini" data-agua="500">+ Garrafa (500)</button>
        ${aguaDo(dia).length ? '<button class="btn btn--mini btn--fantasma" id="b-agua-desfazer">Desfazer</button>' : ''}
      </div>
    </section>

    <section class="cartao">
      <header class="cartao__cab"><h2>Refeições de hoje</h2>
        <div class="acoes">
          <button class="btn btn--mini" id="add-foto">📷 Foto</button>
          <button class="btn btn--mini btn--fantasma" id="add-manual">+ Manual</button>
        </div>
      </header>
      ${refs.length ? `<ul class="lista">${refs.map(itemRefeicao).join('')}</ul>`
        : '<p class="vazio">Nenhuma refeição registrada hoje. Tire uma foto do prato e deixe a IA estimar as calorias.</p>'}
    </section>

    <section class="cartao">
      <header class="cartao__cab"><h2>Atividade física</h2>
        <button class="btn btn--mini btn--fantasma" id="add-atv">+ Registrar</button>
      </header>
      ${ats.length ? `<ul class="lista">${ats.map(itemAtividade).join('')}</ul>`
        : '<p class="vazio">Nenhuma atividade hoje.</p>'}
    </section>`;

  $('#add-foto', v).onclick = () => modalRefeicao({ comFoto: true });
  $('#add-manual', v).onclick = () => modalRefeicao({});
  $('#add-atv', v).onclick = () => modalAtividade();
  $('#b-lembretes', v).onclick = () => modalLembretes();
  $$('[data-agua]', v).forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try {
      const salvo = await sb.inserir('sau_agua', { ml: Number(b.dataset.agua) });
      st.agua.unshift(salvo);
      render();
    } catch (e) { toast(e.message, 'erro'); b.disabled = false; }
  });
  const desfazer = $('#b-agua-desfazer', v);
  if (desfazer) desfazer.onclick = async () => {
    const ultimo = aguaDo(hojeISO()).sort((a, b) => new Date(b.quando) - new Date(a.quando))[0];
    if (!ultimo) return;
    try {
      await sb.apagar('sau_agua', ultimo.id);
      st.agua = st.agua.filter((x) => x.id !== ultimo.id);
      render();
    } catch (e) { toast(e.message, 'erro'); }
  };
  $$('[data-ir]', v).forEach((a) => a.onclick = (e) => { e.preventDefault(); irPara(a.dataset.ir); });
  ligarListas(v);
}

/* ---------- lembretes de água (notificações push) ---------- */

const VAPID_PUBLICA = 'BAycI82h47oSmMOdpXpWnAQc5zZuYa4JqK7VsVdTbNj3AqfGMZxmWCDgUMiBnGFRVG_jaj3PnJ1QMHyw55EWzg8';

function b64paraBytes(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const bruto = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bruto, (c) => c.charCodeAt(0));
}

async function inscricaoAtual() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function modalLembretes() {
  const suportado = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iosForaDoApp = /iphone|ipad/i.test(navigator.userAgent)
    && !window.matchMedia('(display-mode: standalone)').matches;

  const caixa = modal(`
    <header class="modal__cab"><h2>Lembretes de água</h2>
      <button class="icone" data-fechar>✕</button></header>
    <div class="form">
      ${!suportado ? '<p class="nota">Este navegador não suporta notificações push.</p>' : ''}
      ${iosForaDoApp ? '<p class="nota">📌 No iPhone, primeiro <b>instale o app</b> (Compartilhar → Adicionar à Tela de Início) e ative os lembretes por lá — o iOS só permite notificações para apps instalados.</p>' : ''}
      <p class="nota">Você recebe uma notificação no aparelho lembrando de beber água, no intervalo e horário que escolher — mesmo com o app fechado.</p>
      <div class="linha2">
        <label>A cada
          <select id="lem-intervalo">
            <option value="60">1 hora</option>
            <option value="120" selected>2 horas</option>
            <option value="180">3 horas</option>
          </select>
        </label>
        <label>Entre
          <span style="display:flex;gap:6px;align-items:center">
            <input id="lem-inicio" inputmode="numeric" value="8" style="width:52px;text-align:center">h e
            <input id="lem-fim" inputmode="numeric" value="22" style="width:52px;text-align:center">h
          </span>
        </label>
      </div>
      <p class="nota" id="lem-estado">Verificando…</p>
      <footer class="modal__pe">
        <button type="button" class="btn btn--fantasma" id="lem-testar" hidden>Enviar teste</button>
        <span class="espaco"></span>
        <button type="button" class="btn btn--perigo" id="lem-desativar" hidden>Desativar</button>
        <button type="button" class="btn btn--primario" id="lem-ativar" ${suportado ? '' : 'disabled'}>Ativar lembretes</button>
      </footer>
    </div>`);

  $$('[data-fechar]', caixa).forEach((b) => b.onclick = fecharModal);
  const estado = $('#lem-estado', caixa);
  const bAtivar = $('#lem-ativar', caixa);
  const bDesativar = $('#lem-desativar', caixa);
  const bTestar = $('#lem-testar', caixa);

  (async () => {
    if (!suportado) { estado.textContent = 'Sem suporte neste navegador.'; return; }
    try {
      const sub = await inscricaoAtual();
      if (!sub) { estado.textContent = 'Lembretes desativados neste aparelho.'; return; }
      const linhas = await sb.listar('sau_push', `select=*&endpoint=eq.${encodeURIComponent(sub.endpoint)}`);
      const cfg = linhas && linhas[0];
      if (cfg && cfg.ativo) {
        estado.textContent = `Ativos neste aparelho: a cada ${cfg.intervalo_min / 60}h, das ${cfg.hora_inicio}h às ${cfg.hora_fim}h.`;
        $('#lem-intervalo', caixa).value = String(cfg.intervalo_min);
        $('#lem-inicio', caixa).value = cfg.hora_inicio;
        $('#lem-fim', caixa).value = cfg.hora_fim;
        bDesativar.hidden = false;
        bTestar.hidden = false;
        bAtivar.textContent = 'Salvar alterações';
      } else {
        estado.textContent = 'Lembretes desativados neste aparelho.';
      }
    } catch { estado.textContent = 'Lembretes desativados neste aparelho.'; }
  })();

  bAtivar.onclick = async () => {
    bAtivar.disabled = true; bAtivar.textContent = 'Ativando…';
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Permissão de notificação negada. Libere nas configurações do navegador.');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64paraBytes(VAPID_PUBLICA),
        });
      }
      const intervalo = Number($('#lem-intervalo', caixa).value) || 120;
      const ini = Math.min(23, Math.max(0, Number($('#lem-inicio', caixa).value) || 8));
      const fim = Math.min(24, Math.max(ini + 1, Number($('#lem-fim', caixa).value) || 22));
      await sb.salvarInscricao({
        endpoint: sub.endpoint,
        subscription: sub.toJSON(),
        ativo: true,
        intervalo_min: intervalo,
        hora_inicio: ini,
        hora_fim: fim,
      });
      toast('Lembretes ativados! 💧');
      fecharModal();
    } catch (e) {
      toast(e.message, 'erro');
      bAtivar.disabled = false; bAtivar.textContent = 'Ativar lembretes';
    }
  };

  bDesativar.onclick = async () => {
    try {
      const sub = await inscricaoAtual();
      if (sub) {
        const linhas = await sb.listar('sau_push', `select=id&endpoint=eq.${encodeURIComponent(sub.endpoint)}`);
        for (const l of linhas || []) await sb.apagar('sau_push', l.id);
        await sub.unsubscribe().catch(() => {});
      }
      toast('Lembretes desativados.');
      fecharModal();
    } catch (e) { toast(e.message, 'erro'); }
  };

  bTestar.onclick = async () => {
    bTestar.disabled = true;
    try {
      await sb.push({ acao: 'testar' });
      toast('Teste enviado — a notificação deve chegar em instantes.');
    } catch (e) { toast(e.message, 'erro'); }
    bTestar.disabled = false;
  };
}

const itemRefeicao = (r) => `
  <li class="item" data-ref="${r.id}">
    ${r.foto ? `<img class="item__foto" src="${r.foto}" alt="">` : `<span class="item__icone">${{ cafe: '☕', almoco: '🍽️', jantar: '🌙', lanche: '🍎' }[r.tipo] || '🍽️'}</span>`}
    <div class="item__meio">
      <b>${esc(r.descricao || ({ cafe: 'Café da manhã', almoco: 'Almoço', jantar: 'Jantar', lanche: 'Lanche' }[r.tipo] || 'Refeição'))}</b>
      <small>${fmtHora(r.quando)} · ${({ cafe: 'café', almoco: 'almoço', jantar: 'jantar', lanche: 'lanche' }[r.tipo] || '')}${r.origem !== 'manual' ? ' · 📷 IA' : ''}</small>
    </div>
    <span class="item__valor">${kcal(r.calorias)}</span>
  </li>`;

const itemAtividade = (a) => `
  <li class="item" data-atv="${a.id}">
    <span class="item__icone">🏃</span>
    <div class="item__meio"><b>${esc(a.tipo || 'Atividade')}</b><small>${a.duracao_min} min</small></div>
    <span class="item__valor">${a.calorias != null ? kcal(a.calorias) : ''}</span>
  </li>`;

function ligarListas(v) {
  $$('[data-ref]', v).forEach((li) => li.onclick = () => {
    const r = st.refeicoes.find((x) => x.id === li.dataset.ref);
    if (r) modalRefeicao({ existente: r });
  });
  $$('[data-atv]', v).forEach((li) => li.onclick = () => {
    const a = st.atividades.find((x) => x.id === li.dataset.atv);
    if (a) modalAtividade(a);
  });
}

/* ---------- modal de refeição (foto + IA ou manual) ---------- */

function modalRefeicao({ comFoto = false, existente = null } = {}) {
  const r = existente;
  let fotoAnalise = null;           // base64 grande, só para a IA
  let fotoMini = r?.foto || null;   // miniatura persistida
  let itens = (r?.itens && Array.isArray(r.itens)) ? structuredClone(r.itens) : [];
  let origem = r?.origem || 'manual';

  const caixa = modal(`
    <header class="modal__cab"><h2>${r ? 'Editar refeição' : 'Nova refeição'}</h2>
      <button class="icone" data-fechar>✕</button></header>
    <form id="f-ref" class="form">
      <div class="linha2">
        <label>Tipo
          <select name="tipo">
            <option value="cafe">Café da manhã</option><option value="almoco">Almoço</option>
            <option value="jantar">Jantar</option><option value="lanche" selected>Lanche</option>
          </select>
        </label>
        <label>Quando
          <input type="datetime-local" name="quando" required>
        </label>
      </div>
      <label>Descrição
        <input name="descricao" placeholder="ex.: arroz, feijão e frango grelhado" value="${esc(r?.descricao || '')}">
      </label>

      <div class="foto-area">
        <input type="file" accept="image/*" capture="environment" id="foto-camera" hidden>
        <input type="file" accept="image/*" id="foto-galeria" hidden>
        <div class="foto-previa ${fotoMini ? '' : 'vazia'}" id="foto-previa">
          ${fotoMini ? `<img src="${fotoMini}" alt="Foto da refeição">` : '<span>📷<br>Sem foto</span>'}
        </div>
        <div class="foto-botoes">
          <button type="button" class="btn btn--mini" id="b-camera">Tirar foto</button>
          <button type="button" class="btn btn--mini btn--fantasma" id="b-galeria">Galeria</button>
          <button type="button" class="btn btn--mini btn--ia" id="b-analisar" ${fotoAnalise ? '' : 'disabled'}>✨ Calcular calorias</button>
        </div>
      </div>

      <div id="itens-area"></div>

      <div class="linha2">
        <label>Calorias (kcal) — editável
          <input name="calorias" inputmode="decimal" required value="${r ? Math.round(r.calorias) : ''}" placeholder="ex.: 650">
        </label>
        <label>Proteínas (g) — opcional
          <input name="proteinas" inputmode="decimal" value="${r?.proteinas_g != null ? Math.round(r.proteinas_g) : ''}" placeholder="ex.: 40">
        </label>
      </div>

      <footer class="modal__pe">
        ${r ? '<button type="button" class="btn btn--perigo" id="b-apagar">Apagar</button>' : ''}
        <span class="espaco"></span>
        <button type="button" class="btn btn--fantasma" data-fechar>Cancelar</button>
        <button type="submit" class="btn btn--primario">Salvar</button>
      </footer>
    </form>`);

  const f = $('#f-ref', caixa);
  f.tipo.value = r?.tipo || sugerirTipo();
  const quandoBase = r ? new Date(r.quando) : new Date();
  f.quando.value = `${dataLocal(quandoBase)}T${String(quandoBase.getHours()).padStart(2, '0')}:${String(quandoBase.getMinutes()).padStart(2, '0')}`;

  const desenharItens = () => {
    const area = $('#itens-area', caixa);
    if (!itens.length) { area.innerHTML = ''; return; }
    area.innerHTML = `
      <div class="itens-ia">
        <p class="itens-ia__titulo">Itens identificados (edite à vontade):</p>
        ${itens.map((it, i) => `
          <div class="item-ia" data-i="${i}">
            <div><b>${esc(it.nome)}</b><small>${esc(it.quantidade || '')}</small></div>
            <input inputmode="decimal" value="${Math.round(it.calorias || 0)}" aria-label="Calorias de ${esc(it.nome)}">
            <button type="button" class="icone" title="Remover">✕</button>
          </div>`).join('')}
      </div>`;
    $$('.item-ia', area).forEach((linha) => {
      const i = Number(linha.dataset.i);
      linha.querySelector('input').oninput = (e) => {
        itens[i].calorias = num(e.target.value) || 0;
        origem = 'foto_editada';
        f.calorias.value = Math.round(itens.reduce((s, x) => s + (Number(x.calorias) || 0), 0));
      };
      linha.querySelector('button').onclick = () => {
        itens.splice(i, 1);
        origem = 'foto_editada';
        f.calorias.value = Math.round(itens.reduce((s, x) => s + (Number(x.calorias) || 0), 0));
        desenharItens();
      };
    });
  };
  desenharItens();

  const receberArquivo = async (arquivo) => {
    if (!arquivo) return;
    try {
      [fotoAnalise, fotoMini] = await Promise.all([
        comprimir(arquivo, 1024, 0.8),
        comprimir(arquivo, 420, 0.72),
      ]);
      $('#foto-previa', caixa).classList.remove('vazia');
      $('#foto-previa', caixa).innerHTML = `<img src="${fotoMini}" alt="Foto da refeição">`;
      $('#b-analisar', caixa).disabled = false;
    } catch (e) { toast(e.message, 'erro'); }
  };
  $('#b-camera', caixa).onclick = () => $('#foto-camera', caixa).click();
  $('#b-galeria', caixa).onclick = () => $('#foto-galeria', caixa).click();
  $('#foto-camera', caixa).onchange = (e) => receberArquivo(e.target.files[0]);
  $('#foto-galeria', caixa).onchange = (e) => receberArquivo(e.target.files[0]);

  $('#b-analisar', caixa).onclick = async () => {
    if (!fotoAnalise) return;
    const b = $('#b-analisar', caixa);
    b.disabled = true; b.textContent = 'Analisando…';
    try {
      const resp = await sb.ia({
        acao: 'refeicao',
        imagem: fotoAnalise,
        mediaType: 'jpeg',
        descricao: f.descricao.value.trim(),
      });
      const res = resp.resultado || {};
      itens = res.itens || [];
      origem = 'foto';
      f.calorias.value = Math.round(res.total_calorias || itens.reduce((s, x) => s + (Number(x.calorias) || 0), 0));
      const prot = itens.reduce((s, x) => s + (Number(x.proteinas_g) || 0), 0);
      if (prot > 0) f.proteinas.value = Math.round(prot);
      if (!f.descricao.value.trim() && itens.length) f.descricao.value = itens.map((i) => i.nome).slice(0, 4).join(', ');
      desenharItens();
      if (res.observacao) toast(res.observacao, res.itens?.length ? 'info' : 'erro');
      if (res.confianca != null && res.confianca < 0.5) toast('Estimativa incerta — confira as calorias.', 'info');
    } catch (e) {
      toast('Análise falhou: ' + e.message, 'erro');
    } finally {
      b.disabled = false; b.textContent = '✨ Calcular calorias';
    }
  };

  if (r) $('#b-apagar', caixa).onclick = async () => {
    if (!confirm('Apagar esta refeição?')) return;
    try {
      await sb.apagar('sau_refeicoes', r.id);
      st.refeicoes = st.refeicoes.filter((x) => x.id !== r.id);
      fecharModal(); render(); toast('Refeição apagada.');
    } catch (e) { toast(e.message, 'erro'); }
  };

  $$('[data-fechar]', caixa).forEach((b) => b.onclick = fecharModal);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const cal = num(f.calorias.value);
    if (cal == null || cal < 0) { toast('Informe as calorias.', 'erro'); return; }
    const iaTotal = itens.length ? Math.round(itens.reduce((s, x) => s + (Number(x.calorias) || 0), 0)) : null;
    const linha = {
      tipo: f.tipo.value,
      quando: new Date(f.quando.value).toISOString(),
      descricao: f.descricao.value.trim(),
      calorias: cal,
      proteinas_g: num(f.proteinas.value),
      origem: itens.length ? (iaTotal !== Math.round(cal) ? 'foto_editada' : origem) : 'manual',
      itens: itens.length ? itens : null,
      foto: fotoMini,
    };
    try {
      if (r) {
        const salvo = await sb.alterar('sau_refeicoes', r.id, linha);
        st.refeicoes = st.refeicoes.map((x) => (x.id === r.id ? salvo : x));
      } else {
        const salvo = await sb.inserir('sau_refeicoes', linha);
        st.refeicoes.unshift(salvo);
      }
      fecharModal(); render(); toast('Refeição salva.');
    } catch (er) { toast(er.message, 'erro'); }
  };
}

function sugerirTipo() {
  const h = new Date().getHours();
  return h < 10 ? 'cafe' : h < 14 ? 'almoco' : h < 18 ? 'lanche' : 'jantar';
}

/* ---------- modal de atividade ---------- */

function modalAtividade(a = null) {
  const caixa = modal(`
    <header class="modal__cab"><h2>${a ? 'Editar atividade' : 'Nova atividade'}</h2>
      <button class="icone" data-fechar>✕</button></header>
    <form id="f-atv" class="form">
      <div class="linha2">
        <label>Tipo
          <select name="tipo">${ATIVIDADES_MET.map(([n]) => `<option>${n}</option>`).join('')}</select>
        </label>
        <label>Data <input type="date" name="data" required value="${a ? String(a.data).slice(0, 10) : hojeISO()}"></label>
      </div>
      <div class="linha2">
        <label>Duração (min) <input name="duracao" inputmode="numeric" required value="${a?.duracao_min || ''}" placeholder="ex.: 40"></label>
        <label>Calorias (auto) <input name="calorias" inputmode="numeric" value="${a?.calorias != null ? Math.round(a.calorias) : ''}" placeholder="calculo automático"></label>
      </div>
      <label>Observação <input name="obs" value="${esc(a?.obs || '')}"></label>
      <footer class="modal__pe">
        ${a ? '<button type="button" class="btn btn--perigo" id="b-apagar">Apagar</button>' : ''}
        <span class="espaco"></span>
        <button type="button" class="btn btn--fantasma" data-fechar>Cancelar</button>
        <button type="submit" class="btn btn--primario">Salvar</button>
      </footer>
    </form>`);

  const f = $('#f-atv', caixa);
  if (a) f.tipo.value = a.tipo;
  const autoCal = () => {
    const min = num(f.duracao.value);
    if (min) f.calorias.value = calAtividade(f.tipo.value, min);
  };
  f.tipo.onchange = autoCal;
  f.duracao.oninput = autoCal;

  if (a) $('#b-apagar', caixa).onclick = async () => {
    if (!confirm('Apagar esta atividade?')) return;
    try {
      await sb.apagar('sau_atividades', a.id);
      st.atividades = st.atividades.filter((x) => x.id !== a.id);
      fecharModal(); render(); toast('Atividade apagada.');
    } catch (e) { toast(e.message, 'erro'); }
  };

  $$('[data-fechar]', caixa).forEach((b) => b.onclick = fecharModal);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const linha = {
      tipo: f.tipo.value,
      data: f.data.value,
      duracao_min: Math.round(num(f.duracao.value) || 0),
      calorias: num(f.calorias.value),
      obs: f.obs.value.trim(),
    };
    if (!linha.duracao_min) { toast('Informe a duração.', 'erro'); return; }
    try {
      if (a) {
        const salvo = await sb.alterar('sau_atividades', a.id, linha);
        st.atividades = st.atividades.map((x) => (x.id === a.id ? salvo : x));
      } else {
        const salvo = await sb.inserir('sau_atividades', linha);
        st.atividades.unshift(salvo);
      }
      fecharModal(); render(); toast('Atividade salva.');
    } catch (er) { toast(er.message, 'erro'); }
  };
}

/* ---------- Exames ---------- */

function telaExames(v) {
  const porData = {};
  for (const e of st.exames) (porData[e.data] ||= []).push(e);
  const datas = Object.keys(porData).sort().reverse();

  v.innerHTML = `
    <section class="cartao">
      <header class="cartao__cab"><h2>Meus exames</h2>
        <div class="acoes">
          <button class="btn btn--mini btn--ia" id="importar-laudo">📄 Importar laudo</button>
          <button class="btn btn--mini btn--fantasma" id="add-exame">+ Lançar</button>
        </div>
      </header>
      ${datas.length ? datas.map((d) => `
        <h3 class="grupo-data">${fmtData(d)}</h3>
        <ul class="lista">
          ${porData[d].map((e) => {
            const [rotulo, cor] = statusExame(e);
            return `<li class="item" data-ex="${e.id}">
              <div class="item__meio"><b>${esc(e.exame)}</b>
                <small>${e.ref_min != null || e.ref_max != null ? `ref.: ${e.ref_min ?? '—'} a ${e.ref_max ?? '—'} ${esc(e.unidade)}` : ''}</small></div>
              <div class="item__fim"><span class="item__valor">${e.valor} ${esc(e.unidade)}</span>
                ${rotulo !== '—' ? `<span class="selo selo--${cor}">${rotulo}</span>` : ''}</div>
            </li>`;
          }).join('')}
        </ul>`).join('')
        : '<p class="vazio">Nenhum exame lançado. Registre os resultados dos seus exames de laboratório para acompanhar sua saúde.</p>'}
    </section>`;

  $('#add-exame', v).onclick = () => modalExame();
  $('#importar-laudo', v).onclick = () => modalImportarLaudo();
  $$('[data-ex]', v).forEach((li) => li.onclick = () => {
    const e = st.exames.find((x) => x.id === li.dataset.ex);
    if (e) modalExame(e);
  });
}

/* ---------- importação de laudo (PDF ou foto) ---------- */

function modalImportarLaudo() {
  let arquivo = null;       // base64 sem prefixo
  let mediaType = 'pdf';
  let extraidos = [];       // [{exame, valor, unidade, ref_min, ref_max, incluir}]

  const caixa = modal(`
    <header class="modal__cab"><h2>Importar laudo de exames</h2>
      <button class="icone" data-fechar>✕</button></header>
    <div class="form">
      <p class="nota">Envie o <b>PDF do laudo</b> do laboratório (ou uma foto nítida dele).
      A IA lê o documento, lista os exames com valores e faixas de referência, e você revisa antes de salvar.</p>
      <input type="file" id="arq-laudo" accept="application/pdf,image/*" hidden>
      <div class="foto-botoes" style="display:flex;gap:8px">
        <button type="button" class="btn btn--fantasma" id="b-escolher">📄 Escolher arquivo</button>
        <button type="button" class="btn btn--ia" id="b-extrair" disabled>✨ Ler laudo</button>
      </div>
      <p class="nota" id="nome-arquivo"></p>
      <div id="laudo-resultado"></div>
    </div>`);

  const bExtrair = $('#b-extrair', caixa);

  $('#b-escolher', caixa).onclick = () => $('#arq-laudo', caixa).click();
  $('#arq-laudo', caixa).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      if (f.type === 'application/pdf') {
        if (f.size > 10 * 1024 * 1024) throw new Error('PDF muito grande (máx. 10 MB).');
        mediaType = 'pdf';
        arquivo = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1]);
          r.onerror = () => rej(new Error('Não consegui ler o arquivo.'));
          r.readAsDataURL(f);
        });
      } else {
        mediaType = 'jpeg';
        arquivo = (await comprimir(f, 1800, 0.85)).split(',')[1];
      }
      $('#nome-arquivo', caixa).textContent = `Arquivo: ${f.name}`;
      bExtrair.disabled = false;
    } catch (er) { toast(er.message, 'erro'); }
  };

  const desenharExtraidos = (dataExame) => {
    const area = $('#laudo-resultado', caixa);
    if (!extraidos.length) { area.innerHTML = ''; return; }
    area.innerHTML = `
      <div class="itens-ia">
        <p class="itens-ia__titulo">Exames encontrados — desmarque o que não quiser salvar:</p>
        ${extraidos.map((x, i) => `
          <label class="laudo-item" data-i="${i}">
            <input type="checkbox" ${x.incluir ? 'checked' : ''}>
            <span class="laudo-item__nome"><b>${esc(x.exame)}</b>
              <small>${x.ref_min !== null || x.ref_max !== null ? `ref.: ${x.ref_min ?? '—'} a ${x.ref_max ?? '—'}` : 'sem referência'}</small></span>
            <span class="item__valor">${x.valor} ${esc(x.unidade)}</span>
          </label>`).join('')}
      </div>
      <label>Data dos exames
        <input type="date" id="data-laudo" value="${dataExame || hojeISO()}">
      </label>
      <footer class="modal__pe">
        <span class="espaco"></span>
        <button type="button" class="btn btn--fantasma" data-fechar>Cancelar</button>
        <button type="button" class="btn btn--primario" id="b-salvar-laudo">Salvar e avaliar</button>
      </footer>`;
    $$('.laudo-item input', area).forEach((cb, i) => cb.onchange = () => { extraidos[i].incluir = cb.checked; });
    $$('[data-fechar]', area).forEach((b) => b.onclick = fecharModal);

    $('#b-salvar-laudo', area).onclick = async () => {
      const data = $('#data-laudo', area).value || hojeISO();
      const selecionados = extraidos.filter((x) => x.incluir);
      if (!selecionados.length) { toast('Nenhum exame selecionado.', 'erro'); return; }
      const b = $('#b-salvar-laudo', area);
      b.disabled = true; b.textContent = 'Salvando…';
      try {
        for (const x of selecionados) {
          const salvo = await sb.inserir('sau_exames', {
            exame: x.exame, valor: x.valor, unidade: x.unidade,
            ref_min: x.ref_min, ref_max: x.ref_max, data, obs: 'importado de laudo',
          });
          st.exames.unshift(salvo);
        }
        st.exames.sort((a, b2) => String(b2.data).localeCompare(String(a.data)));
        fecharModal();
        toast(`${selecionados.length} exame(s) salvos. Gerando avaliação…`);
        irPara('saude');
        gerarAvaliacao();
      } catch (er) {
        toast(er.message, 'erro');
        b.disabled = false; b.textContent = 'Salvar e avaliar';
      }
    };
  };

  bExtrair.onclick = async () => {
    if (!arquivo) return;
    bExtrair.disabled = true; bExtrair.textContent = 'Lendo laudo…';
    try {
      const resp = await sb.ia({ acao: 'exames', arquivo, mediaType }, 180000);
      const res = resp.resultado || {};
      // faixas: zero ou negativo = "não informado" (ex.: "inferior a 190" não tem mínimo)
      const ref = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };
      extraidos = (res.exames || []).map((x) => {
        let mn = ref(x.ref_min), mx = ref(x.ref_max);
        if (mn != null && mx != null && mx < mn) mx = null;
        return {
          exame: String(x.exame || '').trim() || 'Exame',
          valor: Number(x.valor),
          unidade: String(x.unidade || '').trim(),
          ref_min: mn,
          ref_max: mx,
          incluir: true,
        };
      }).filter((x) => Number.isFinite(x.valor));
      const dataExame = /^\d{4}-\d{2}-\d{2}$/.test(res.data_exame || '') ? res.data_exame : '';
      desenharExtraidos(dataExame);
      if (!extraidos.length) toast(res.observacao || 'Nenhum exame encontrado no documento.', 'erro');
      else if (res.observacao) toast(res.observacao, 'info');
    } catch (er) {
      toast('Leitura falhou: ' + er.message, 'erro');
    } finally {
      bExtrair.disabled = false; bExtrair.textContent = '✨ Ler laudo';
    }
  };

  $$('[data-fechar]', caixa).forEach((b) => b.onclick = fecharModal);
}

function modalExame(e = null) {
  const caixa = modal(`
    <header class="modal__cab"><h2>${e ? 'Editar exame' : 'Lançar exame'}</h2>
      <button class="icone" data-fechar>✕</button></header>
    <form id="f-ex" class="form">
      <label>Exame
        <select name="modelo">${EXAMES_MODELO.map((m) => `<option>${m.nome}</option>`).join('')}</select>
      </label>
      <label id="l-nome" hidden>Nome do exame <input name="nome"></label>
      <div class="linha2">
        <label>Valor <input name="valor" inputmode="decimal" required value="${e?.valor ?? ''}"></label>
        <label>Unidade <input name="unidade" value="${esc(e?.unidade ?? '')}"></label>
      </div>
      <div class="linha2">
        <label>Ref. mínima <input name="refmin" inputmode="decimal" value="${e?.ref_min ?? ''}"></label>
        <label>Ref. máxima <input name="refmax" inputmode="decimal" value="${e?.ref_max ?? ''}"></label>
      </div>
      <div class="linha2">
        <label>Data <input type="date" name="data" required value="${e ? String(e.data).slice(0, 10) : hojeISO()}"></label>
        <label>Observação <input name="obs" value="${esc(e?.obs || '')}"></label>
      </div>
      <p class="nota">As faixas de referência vêm preenchidas com valores usuais para adultos — confira com as do seu laboratório.</p>
      <footer class="modal__pe">
        ${e ? '<button type="button" class="btn btn--perigo" id="b-apagar">Apagar</button>' : ''}
        <span class="espaco"></span>
        <button type="button" class="btn btn--fantasma" data-fechar>Cancelar</button>
        <button type="submit" class="btn btn--primario">Salvar</button>
      </footer>
    </form>`);

  const f = $('#f-ex', caixa);
  const aplicarModelo = () => {
    const m = EXAMES_MODELO.find((x) => x.nome === f.modelo.value);
    $('#l-nome', caixa).hidden = m.nome !== 'Outro';
    if (m.nome !== 'Outro') {
      f.unidade.value = m.unidade;
      f.refmin.value = m.min ?? '';
      f.refmax.value = m.max ?? '';
    }
  };
  if (e) {
    const m = EXAMES_MODELO.find((x) => x.nome === e.exame);
    f.modelo.value = m ? m.nome : 'Outro';
    if (!m) { $('#l-nome', caixa).hidden = false; f.nome.value = e.exame; }
  } else {
    aplicarModelo();
  }
  f.modelo.onchange = aplicarModelo;

  if (e) $('#b-apagar', caixa).onclick = async () => {
    if (!confirm('Apagar este exame?')) return;
    try {
      await sb.apagar('sau_exames', e.id);
      st.exames = st.exames.filter((x) => x.id !== e.id);
      fecharModal(); render(); toast('Exame apagado.');
    } catch (er) { toast(er.message, 'erro'); }
  };

  $$('[data-fechar]', caixa).forEach((b) => b.onclick = fecharModal);
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const nome = f.modelo.value === 'Outro' ? f.nome.value.trim() : f.modelo.value;
    if (!nome) { toast('Informe o nome do exame.', 'erro'); return; }
    const linha = {
      exame: nome,
      valor: num(f.valor.value),
      unidade: f.unidade.value.trim(),
      ref_min: num(f.refmin.value),
      ref_max: num(f.refmax.value),
      data: f.data.value,
      obs: f.obs.value.trim(),
    };
    if (linha.valor == null) { toast('Informe o valor.', 'erro'); return; }
    try {
      if (e) {
        const salvo = await sb.alterar('sau_exames', e.id, linha);
        st.exames = st.exames.map((x) => (x.id === e.id ? salvo : x));
      } else {
        const salvo = await sb.inserir('sau_exames', linha);
        st.exames.unshift(salvo);
      }
      fecharModal(); render(); toast('Exame salvo.');
    } catch (er) { toast(er.message, 'erro'); }
  };
}

/* ---------- Evolução (gráficos em canvas) ---------- */

function telaEvolucao(v) {
  v.innerHTML = `
    <section class="cartao"><h2 class="cartao__titulo">Peso (kg)</h2><canvas id="g-peso" height="170"></canvas></section>
    <section class="cartao"><h2 class="cartao__titulo">Calorias por dia — últimos 14 dias</h2><canvas id="g-cal" height="170"></canvas></section>
    <section class="cartao"><h2 class="cartao__titulo">Atividade física (min/semana)</h2><canvas id="g-atv" height="170"></canvas></section>`;

  const pesos = st.medidas.filter((m) => m.peso_kg != null)
    .map((m) => ({ x: String(m.data).slice(0, 10), y: Number(m.peso_kg) }))
    .sort((a, b) => a.x.localeCompare(b.x));
  desenharLinha($('#g-peso', v), pesos, { unidade: 'kg' });

  const dias = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const iso = dataLocal(d);
    dias.push({ x: iso.slice(8) + '/' + iso.slice(5, 7), y: somaCal(refeicoesDo(iso)) });
  }
  desenharBarras($('#g-cal', v), dias, { linhaMeta: metaCalorias() });

  const semanas = [];
  for (let i = 7; i >= 0; i--) {
    const fim = new Date(Date.now() - i * 7 * 864e5);
    const ini = new Date(fim.getTime() - 6 * 864e5);
    const total = st.atividades.filter((a) => {
      const t = new Date(a.data + 'T12:00').getTime();
      return t >= ini.getTime() && t <= fim.getTime();
    }).reduce((s, a) => s + (Number(a.duracao_min) || 0), 0);
    semanas.push({ x: `${String(ini.getDate()).padStart(2, '0')}/${String(ini.getMonth() + 1).padStart(2, '0')}`, y: total });
  }
  desenharBarras($('#g-atv', v), semanas, { linhaMeta: 150, corMeta: '#18b06b' });
}

function prepararCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const cs = getComputedStyle(cv.parentElement);
  const w = cv.parentElement.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  cv.style.width = w + 'px';
  cv.width = w * dpr;
  cv.height = 170 * dpr;
  const cx = cv.getContext('2d');
  cx.scale(dpr, dpr);
  const cor = getComputedStyle(document.body).color;
  return { cx, w, h: 170, cor };
}

function desenharLinha(cv, pontos, { unidade = '' } = {}) {
  const { cx, w, h, cor } = prepararCanvas(cv);
  if (pontos.length < 2) { textoVazio(cx, w, h, cor, 'Registre seu peso no Perfil para ver a evolução.'); return; }
  const ys = pontos.map((p) => p.y);
  const min = Math.min(...ys), max = Math.max(...ys);
  const folga = Math.max(0.5, (max - min) * 0.15);
  const y0 = min - folga, y1 = max + folga;
  const mx = 34, my = 22;
  const px = (i) => mx + (i / (pontos.length - 1)) * (w - mx - 10);
  const py = (yv) => h - my - ((yv - y0) / (y1 - y0)) * (h - my - 14);

  cx.strokeStyle = cor; cx.globalAlpha = 0.15;
  [y0, (y0 + y1) / 2, y1].forEach((yv) => { cx.beginPath(); cx.moveTo(mx, py(yv)); cx.lineTo(w - 8, py(yv)); cx.stroke(); });
  cx.globalAlpha = 0.6; cx.fillStyle = cor; cx.font = '10px system-ui';
  [y0, (y0 + y1) / 2, y1].forEach((yv) => cx.fillText(yv.toFixed(1), 2, py(yv) + 3));
  cx.globalAlpha = 1;

  cx.strokeStyle = '#18b06b'; cx.lineWidth = 2; cx.beginPath();
  pontos.forEach((p, i) => (i ? cx.lineTo(px(i), py(p.y)) : cx.moveTo(px(i), py(p.y))));
  cx.stroke();
  cx.fillStyle = '#18b06b';
  pontos.forEach((p, i) => { cx.beginPath(); cx.arc(px(i), py(p.y), 3, 0, 7); cx.fill(); });

  cx.fillStyle = cor; cx.globalAlpha = 0.6; cx.font = '10px system-ui';
  const passo = Math.ceil(pontos.length / 6);
  pontos.forEach((p, i) => { if (i % passo === 0 || i === pontos.length - 1) cx.fillText(p.x.slice(8) + '/' + p.x.slice(5, 7), px(i) - 12, h - 6); });
  cx.globalAlpha = 1;
  cx.fillText(unidade, w - 24, 12);
}

function desenharBarras(cv, barras, { linhaMeta = null, corMeta = '#d98324' } = {}) {
  const { cx, w, h, cor } = prepararCanvas(cv);
  const max = Math.max(...barras.map((b) => b.y), linhaMeta || 0, 10) * 1.15;
  const mx = 34, my = 22;
  const larg = (w - mx - 10) / barras.length;
  const py = (yv) => h - my - (yv / max) * (h - my - 14);

  cx.globalAlpha = 0.6; cx.fillStyle = cor; cx.font = '10px system-ui';
  [0, max / 2, max].forEach((yv) => cx.fillText(String(Math.round(yv)), 2, py(yv) + 3));
  cx.globalAlpha = 1;

  barras.forEach((b, i) => {
    cx.fillStyle = '#0e8f8f';
    cx.globalAlpha = b.y ? 0.9 : 0.25;
    const bh = Math.max(2, (h - my - 14) * (b.y / max));
    cx.beginPath();
    cx.roundRect(mx + i * larg + larg * 0.18, h - my - bh, larg * 0.64, bh, 3);
    cx.fill();
  });
  cx.globalAlpha = 0.7; cx.fillStyle = cor;
  const passo = Math.ceil(barras.length / 7);
  barras.forEach((b, i) => { if (i % passo === 0) cx.fillText(b.x, mx + i * larg, h - 6); });
  cx.globalAlpha = 1;

  if (linhaMeta) {
    cx.strokeStyle = corMeta; cx.setLineDash([5, 4]); cx.lineWidth = 1.5;
    cx.beginPath(); cx.moveTo(mx, py(linhaMeta)); cx.lineTo(w - 8, py(linhaMeta)); cx.stroke();
    cx.setLineDash([]);
  }
}

function textoVazio(cx, w, h, cor, msg) {
  cx.fillStyle = cor; cx.globalAlpha = 0.55; cx.font = '12px system-ui';
  cx.fillText(msg, 12, h / 2);
  cx.globalAlpha = 1;
}

/* ---------- Saúde (indicadores + IA) ---------- */

function telaSaude(v) {
  const vImc = imc();
  const [rotImc, corImc] = classeIMC(vImc);
  const meta = metaCalorias();
  const media7 = mediaCalorias(7);
  const minSem = minutosAtividadeSemana();
  const pa = pressaoAtual();
  const foraFaixa = ultimosExames().filter((e) => statusExame(e)[0] !== 'Normal' && statusExame(e)[0] !== '—');

  v.innerHTML = `
    <section class="grade-ind">
      ${cartaoInd('IMC', vImc ? vImc.toFixed(1) : '—', rotImc, corImc)}
      ${cartaoInd('Meta diária', meta ? `${meta} kcal` : '—', st.perfil?.meta_calorias ? 'definida por você' : 'estimada (TMB)', '')}
      ${cartaoInd('Média 7 dias', media7 ? `${Math.round(media7)} kcal` : '—', meta && media7 ? (media7 <= meta ? 'dentro da meta' : 'acima da meta') : 'registre refeições', meta && media7 ? (media7 <= meta ? 'bom' : 'atencao') : '')}
      ${cartaoInd('Atividade/semana', `${minSem} min`, minSem >= 150 ? 'meta OMS atingida' : 'meta OMS: 150 min', minSem >= 150 ? 'bom' : 'atencao')}
      ${cartaoInd('Água hoje', `${aguaHoje()} ml`, `meta: ${metaAgua()} ml`, aguaHoje() >= metaAgua() ? 'bom' : 'atencao')}
      ${metaProteina() ? cartaoInd('Proteína hoje', `${Math.round(proteinaDo(hojeISO()))} g`, `meta: ${metaProteina()} g/dia`, proteinaDo(hojeISO()) >= metaProteina() * 0.8 ? 'bom' : 'atencao') : ''}
      ${pa ? cartaoInd('Pressão', `${pa.pressao_sist}/${pa.pressao_diast}`, fmtData(pa.data), Number(pa.pressao_sist) >= 140 || Number(pa.pressao_diast) >= 90 ? 'ruim' : Number(pa.pressao_sist) >= 130 ? 'atencao' : 'bom') : ''}
    </section>

    ${foraFaixa.length ? `
    <section class="cartao">
      <h2 class="cartao__titulo">Exames que merecem atenção</h2>
      <ul class="lista">${foraFaixa.map((e) => {
        const [rot, c] = statusExame(e);
        return `<li class="item"><div class="item__meio"><b>${esc(e.exame)}</b><small>${fmtData(e.data)} · ref.: ${e.ref_min ?? '—'} a ${e.ref_max ?? '—'}</small></div>
          <div class="item__fim"><span class="item__valor">${e.valor} ${esc(e.unidade)}</span><span class="selo selo--${c}">${rot}</span></div></li>`;
      }).join('')}</ul>
    </section>` : ''}

    <section class="cartao">
      <header class="cartao__cab"><h2>Avaliação completa com IA</h2>
        <button class="btn btn--mini btn--ia" id="b-avaliar">✨ Gerar análise</button>
      </header>
      <div id="ia-saida" class="prosa">${st.avaliacaoIA ? md(st.avaliacaoIA) + `<p class="nota">Gerada em ${st.avaliacaoQuando}.</p>` : '<p class="vazio">A IA cruza seu perfil, exames, alimentação e atividade física e escreve uma avaliação com orientações práticas.</p>'}</div>
    </section>

    <p class="nota nota--central">⚠️ Este aplicativo é informativo e não substitui consulta, diagnóstico ou tratamento médico.</p>`;

  $('#b-avaliar', v).onclick = () => gerarAvaliacao();
}

/** Gera a avaliação por IA; usada pelo botão da aba Saúde e após importar laudo. */
async function gerarAvaliacao() {
  const b = $('#b-avaliar');
  if (b) { b.disabled = true; b.textContent = 'Analisando…'; }
  const saida = $('#ia-saida');
  if (saida) saida.innerHTML = '<p class="vazio">Cruzando seus exames, perfil e hábitos…</p>';
  try {
    const resp = await sb.ia({ acao: 'avaliacao', dados: dadosParaIA() }, 120000);
    st.avaliacaoIA = resp.avaliacao || '';
    st.avaliacaoQuando = new Date().toLocaleString('pt-BR');
    localStorage.setItem('saude.avaliacao', st.avaliacaoIA);
    localStorage.setItem('saude.avaliacaoQuando', st.avaliacaoQuando);
    if ($('#ia-saida')) $('#ia-saida').innerHTML = md(st.avaliacaoIA) + `<p class="nota">Gerada em ${st.avaliacaoQuando}.</p>`;
  } catch (e) {
    toast('Não consegui gerar a análise: ' + e.message, 'erro');
    if ($('#ia-saida')) $('#ia-saida').innerHTML = '<p class="vazio">A análise falhou — tente de novo.</p>';
  } finally {
    const b2 = $('#b-avaliar');
    if (b2) { b2.disabled = false; b2.textContent = '✨ Gerar análise'; }
  }
}

const cartaoInd = (titulo, valor, sub, cor) => `
  <div class="ind ${cor ? 'ind--' + cor : ''}">
    <small>${titulo}</small><b>${valor}</b><span>${sub}</span>
  </div>`;

/** Último resultado de cada exame. */
function ultimosExames() {
  const vistos = new Set(), ultimos = [];
  for (const e of st.exames) {
    if (vistos.has(e.exame)) continue;
    vistos.add(e.exame);
    ultimos.push(e);
  }
  return ultimos;
}

function dadosParaIA() {
  return {
    data_de_hoje: hojeISO(),
    perfil: {
      idade: idade(), sexo: st.perfil?.sexo || null,
      altura_cm: st.perfil?.altura_cm || null, peso_kg: pesoAtual(),
      imc: imc() ? Number(imc().toFixed(1)) : null,
      nivel_atividade: st.perfil?.nivel_atividade || null,
      objetivo: st.perfil?.objetivo || null,
      meta_calorias_dia: metaCalorias(),
    },
    exames_mais_recentes: ultimosExames().slice(0, 25).map((e) => ({
      exame: e.exame, data: e.data, valor: Number(e.valor), unidade: e.unidade,
      ref_min: e.ref_min, ref_max: e.ref_max,
    })),
    medidas_recentes: st.medidas.slice(0, 20).map((m) => ({
      data: m.data, peso_kg: m.peso_kg, pressao: m.pressao_sist ? `${m.pressao_sist}/${m.pressao_diast}` : null,
    })),
    alimentacao: {
      media_kcal_dia_7d: mediaCalorias(7) ? Math.round(mediaCalorias(7)) : null,
      media_kcal_dia_30d: mediaCalorias(30) ? Math.round(mediaCalorias(30)) : null,
      refeicoes_ultimos_3_dias: st.refeicoes
        .filter((r) => Date.now() - new Date(r.quando).getTime() < 3 * 864e5)
        .map((r) => ({ quando: r.quando, tipo: r.tipo, descricao: r.descricao, kcal: Math.round(r.calorias) })),
    },
    atividade_fisica: {
      minutos_ultima_semana: minutosAtividadeSemana(),
      ultimas: st.atividades.slice(0, 15).map((a) => ({ data: a.data, tipo: a.tipo, min: a.duracao_min, kcal: a.calorias })),
    },
    hidratacao: {
      hoje_ml: aguaHoje(),
      meta_ml_dia: metaAgua(),
      media_7d_ml: mediaAgua(7) ? Math.round(mediaAgua(7)) : null,
      temperatura_maxima_hoje: st.clima?.tmax ?? null,
    },
    proteina: {
      hoje_g: Math.round(proteinaDo(hojeISO())),
      meta_g_dia: metaProteina(),
      media_7d_g: mediaProteina(7) ? Math.round(mediaProteina(7)) : null,
    },
  };
}

/* ---------- Perfil ---------- */

function telaPerfil(v) {
  const p = st.perfil || {};
  const u = sb.usuario();
  v.innerHTML = `
    <section class="cartao">
      <h2 class="cartao__titulo">Meus dados</h2>
      <form id="f-perfil" class="form">
        <label>Nome <input name="nome" value="${esc(p.nome || '')}"></label>
        <div class="linha2">
          <label>Nascimento <input type="date" name="nascimento" value="${p.nascimento || ''}"></label>
          <label>Sexo
            <select name="sexo">
              <option value="">—</option>
              <option value="M" ${p.sexo === 'M' ? 'selected' : ''}>Masculino</option>
              <option value="F" ${p.sexo === 'F' ? 'selected' : ''}>Feminino</option>
            </select>
          </label>
        </div>
        <div class="linha2">
          <label>Altura (cm) <input name="altura" inputmode="decimal" value="${p.altura_cm || ''}" placeholder="ex.: 165"></label>
          <label>Nível de atividade
            <select name="nivel">
              ${['sedentario', 'leve', 'moderado', 'intenso'].map((n) => `<option value="${n}" ${p.nivel_atividade === n ? 'selected' : ''}>${{ sedentario: 'Sedentário', leve: 'Leve', moderado: 'Moderado', intenso: 'Intenso' }[n]}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="linha2">
          <label>Objetivo
            <select name="objetivo">
              ${['perder', 'manter', 'ganhar'].map((o) => `<option value="${o}" ${(p.objetivo || 'manter') === o ? 'selected' : ''}>${{ perder: 'Perder peso', manter: 'Manter peso', ganhar: 'Ganhar massa' }[o]}</option>`).join('')}
            </select>
          </label>
          <label>Meta kcal/dia (opcional) <input name="meta" inputmode="numeric" value="${p.meta_calorias || ''}" placeholder="auto"></label>
        </div>
        <button type="submit" class="btn btn--primario">Salvar perfil</button>
      </form>
    </section>

    <section class="cartao">
      <h2 class="cartao__titulo">Registrar peso e pressão</h2>
      <form id="f-medida" class="form">
        <div class="linha2">
          <label>Peso (kg) <input name="peso" inputmode="decimal" placeholder="ex.: 82,5"></label>
          <label>Data <input type="date" name="data" value="${hojeISO()}"></label>
        </div>
        <div class="linha2">
          <label>Pressão sistólica <input name="sist" inputmode="numeric" placeholder="ex.: 120"></label>
          <label>Pressão diastólica <input name="diast" inputmode="numeric" placeholder="ex.: 80"></label>
        </div>
        <button type="submit" class="btn btn--fantasma">Registrar medida</button>
      </form>
      ${st.medidas.length ? `<ul class="lista lista--compacta">${st.medidas.slice(0, 5).map((m) => `
        <li class="item item--simples"><div class="item__meio"><b>${m.peso_kg != null ? m.peso_kg + ' kg' : ''} ${m.pressao_sist ? `· ${m.pressao_sist}/${m.pressao_diast}` : ''}</b><small>${fmtData(m.data)}</small></div>
        <button class="icone" data-apagar-medida="${m.id}" title="Apagar">✕</button></li>`).join('')}</ul>` : ''}
    </section>

    <section class="cartao">
      <h2 class="cartao__titulo">Apple Watch (via app Saúde) ⌚</h2>
      ${p.atalho_token ? `
        <p class="nota">Conexão ativa. O que o atalho do iPhone envia entra sozinho nas abas Hoje e Evolução, marcado como "Apple Watch".</p>
        <p class="nota">Código de conexão: <code class="codigo">${esc(p.atalho_token)}</code></p>
        <div class="acoes" style="margin-top:8px">
          <button class="btn btn--mini" id="b-guia-watch">📖 Passo a passo do atalho</button>
          <button class="btn btn--mini btn--fantasma" id="b-copiar-token">Copiar código</button>
          <button class="btn btn--mini btn--perigo" id="b-remover-token">Desconectar</button>
        </div>`
      : `
        <p class="nota">Traga a atividade do seu Apple Watch (minutos de exercício e calorias): o app Atalhos do iPhone lê os anéis e envia para cá automaticamente.</p>
        <button class="btn btn--primario" id="b-gerar-token">Conectar Apple Watch</button>`}
    </section>

    <section class="cartao">
      <h2 class="cartao__titulo">Conta</h2>
      <p class="nota">Conectado como <b>${esc(u?.email || '')}</b></p>
      <button class="btn btn--perigo" id="b-sair">Sair da conta</button>
    </section>

    <p class="nota nota--central">Minha Saúde · dados privados por usuário · não substitui acompanhamento médico.</p>`;

  $('#f-perfil', v).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const salvo = await sb.salvarPerfil({
        user_id: u.id,
        nome: f.nome.value.trim(),
        nascimento: f.nascimento.value || null,
        sexo: f.sexo.value,
        altura_cm: (() => { const a = num(f.altura.value); return a && a < 3 ? a * 100 : a; })(),
        nivel_atividade: f.nivel.value,
        objetivo: f.objetivo.value,
        meta_calorias: num(f.meta.value) ? Math.round(num(f.meta.value)) : null,
        updated_at: new Date().toISOString(),
      });
      st.perfil = salvo;
      toast('Perfil salvo.');
      render();
    } catch (er) { toast(er.message, 'erro'); }
  };

  $('#f-medida', v).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const peso = num(f.peso.value), sist = num(f.sist.value), diast = num(f.diast.value);
    if (peso == null && sist == null) { toast('Informe peso ou pressão.', 'erro'); return; }
    try {
      const salvo = await sb.inserir('sau_medidas', {
        data: f.data.value, peso_kg: peso,
        pressao_sist: sist ? Math.round(sist) : null,
        pressao_diast: diast ? Math.round(diast) : null,
      });
      st.medidas.unshift(salvo);
      st.medidas.sort((a, b) => String(b.data).localeCompare(String(a.data)));
      f.peso.value = f.sist.value = f.diast.value = '';
      toast('Medida registrada.');
      render();
    } catch (er) { toast(er.message, 'erro'); }
  };

  $$('[data-apagar-medida]', v).forEach((b) => b.onclick = async () => {
    if (!confirm('Apagar esta medida?')) return;
    try {
      await sb.apagar('sau_medidas', b.dataset.apagarMedida);
      st.medidas = st.medidas.filter((x) => x.id !== b.dataset.apagarMedida);
      render();
    } catch (er) { toast(er.message, 'erro'); }
  });

  const bGerar = $('#b-gerar-token', v);
  if (bGerar) bGerar.onclick = async () => {
    bGerar.disabled = true;
    try {
      const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '').slice(0, 40);
      st.perfil = await sb.salvarPerfil({ user_id: u.id, atalho_token: token });
      render();
      modalGuiaWatch();
    } catch (er) { toast(er.message, 'erro'); bGerar.disabled = false; }
  };
  const bGuia = $('#b-guia-watch', v);
  if (bGuia) bGuia.onclick = () => modalGuiaWatch();
  const bCopiar = $('#b-copiar-token', v);
  if (bCopiar) bCopiar.onclick = async () => {
    try { await navigator.clipboard.writeText(st.perfil.atalho_token); toast('Código copiado.'); }
    catch { toast('Não consegui copiar — anote o código exibido.', 'erro'); }
  };
  const bRemover = $('#b-remover-token', v);
  if (bRemover) bRemover.onclick = async () => {
    if (!confirm('Desconectar o Apple Watch? O atalho do iPhone deixa de funcionar.')) return;
    try {
      st.perfil = await sb.salvarPerfil({ user_id: u.id, atalho_token: null });
      render();
      toast('Desconectado.');
    } catch (er) { toast(er.message, 'erro'); }
  };

  $('#b-sair', v).onclick = async () => {
    if (!confirm('Sair da conta?')) return;
    await sb.sair();
    location.reload();
  };
}

/** Guia do atalho do iPhone que envia os treinos do Watch. */
function modalGuiaWatch() {
  const token = st.perfil?.atalho_token || '';
  modal(`
    <header class="modal__cab"><h2>Conectar o Apple Watch</h2>
      <button class="icone" data-fechar>✕</button></header>
    <div class="prosa" style="font-size:13.5px">
      <p>O app <b>Atalhos</b> (já vem no iPhone) lê os anéis de atividade do Watch — <b>minutos de exercício</b> e <b>calorias em movimento</b> — e envia para cá. São só <b>2 ações</b>:</p>
      <h3>1. Criar o atalho</h3>
      <ul>
        <li>Abra o app <b>Atalhos</b> → aba <b>Biblioteca</b> → toque em <b>+</b> no canto superior direito (role até o topo se não aparecer)</li>
        <li>Toque na barra <b>Buscar Ações</b>, digite <b>atividade</b> e escolha <b>"Obter Atividade Física"</b> (ícone laranja). Se ela tiver campo de data, deixe em <b>Hoje</b></li>
        <li>Busque agora por <b>URL</b> e escolha <b>"Obter Conteúdo de URL"</b>. Ela entra logo abaixo — não precisa arrastar nada</li>
      </ul>
      <h3>2. Configurar o envio</h3>
      <ul>
        <li>A ação costuma vir preenchida com a variável <b>Atividade Física</b> (em azul) no lugar do endereço. Toque nela e <b>apague</b> (tecla ⌫ ou o X dela) — só então o campo aceita o endereço</li>
        <li>Com o campo vazio, cole:<br><code class="codigo">https://mhqhbnfbfrfsckhcvzis.supabase.co/functions/v1/saude-atalho</code></li>
        <li>Toque em <b>Mostrar Mais</b> → <b>Método</b>: <b>POST</b> → <b>Corpo da Solicitação</b>: <b>JSON</b></li>
        <li>Toque em <b>Adicionar novo campo</b> → tipo <b>Texto</b>, e crie os <b>3 campos</b> abaixo</li>
      </ul>
      <p><b>Campo 1 — token</b><br>Chave: <b>token</b> · Valor: <code class="codigo">${esc(token)}</code></p>
      <p><b>Campo 2 — exercicio_min</b><br>Chave: <b>exercicio_min</b> · Valor: toque no campo, escolha a variável <b>Atividade Física</b> e depois toque nela para trocar a propriedade para <b>Exercício</b> (os minutos)</p>
      <p><b>Campo 3 — calorias</b><br>Chave: <b>calorias</b> · Valor: mesma variável <b>Atividade Física</b>, com a propriedade <b>Movimento</b> (as calorias ativas)</p>
      <p class="nota">Os nomes das propriedades podem variar um pouco conforme a versão do iOS. O importante: uma delas são os <b>minutos de exercício</b> e a outra são as <b>calorias/energia ativa</b>.</p>
      <ul>
        <li>Renomeie o atalho para <b>Sincronizar Watch</b> e salve</li>
      </ul>
      <h3>3. Testar</h3>
      <ul>
        <li>Rode o atalho pelo botão ▶︎. Na primeira vez o iPhone pede acesso aos dados de Saúde — toque em <b>Permitir</b></li>
        <li>Volte aqui, toque no botão de recarregar (canto superior direito) e veja <b>"Atividade do dia"</b> na aba Hoje</li>
      </ul>
      <h3>4. Automatizar</h3>
      <ul>
        <li>Atalhos → aba <b>Automação</b> → <b>+</b> → <b>Hora do Dia</b> (ex.: 21h30, Diariamente) → <b>Executar Imediatamente</b> → escolha <b>Sincronizar Watch</b></li>
      </ul>
      <p class="nota">Pode rodar quantas vezes quiser por dia: o registro do dia é atualizado, nunca duplicado.</p>
    </div>
    <footer class="modal__pe"><span class="espaco"></span>
      <button class="btn btn--primario" data-fechar>Entendi</button></footer>
  `, { aoAbrir: (caixa) => $$('[data-fechar]', caixa).forEach((b) => b.onclick = fecharModal) });
}

/* ============ navegação e arranque ============ */

function irPara(aba) {
  st.aba = aba;
  render();
  $('#view').scrollTop = 0;
}

$$('.abas button').forEach((b) => b.onclick = () => irPara(b.dataset.aba));

let tRedim;
window.addEventListener('resize', () => {
  clearTimeout(tRedim);
  tRedim = setTimeout(() => { if (!$('#app').hidden) render(); }, 250);
});

$('#btn-sync').onclick = async () => {
  const b = $('#btn-sync');
  b.classList.add('girando');
  try {
    await carregarTudo();
    render();
    toast('Dados atualizados.');
  } catch (e) { toast(e.message, 'erro'); }
  b.classList.remove('girando');
};

function prepararLogin() {
  const form = $('#auth-form');
  const erro = $('#auth-erro');
  const mostrarErro = (m) => { erro.textContent = m; erro.hidden = false; };

  form.onsubmit = async (e) => {
    e.preventDefault();
    erro.hidden = true;
    const b = $('#auth-entrar');
    b.disabled = true; b.textContent = 'Entrando…';
    try {
      await sb.entrar($('#auth-email').value.trim(), $('#auth-senha').value);
      await iniciarApp();
    } catch (er) {
      mostrarErro(er.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : er.message);
    } finally {
      b.disabled = false; b.textContent = 'Entrar';
    }
  };

  $('#auth-criar').onclick = async () => {
    erro.hidden = true;
    const email = $('#auth-email').value.trim(), senha = $('#auth-senha').value;
    if (!email || senha.length < 6) { mostrarErro('Preencha e-mail e uma senha com pelo menos 6 caracteres.'); return; }
    const b = $('#auth-criar');
    b.disabled = true; b.textContent = 'Criando…';
    try {
      await sb.criarConta(email, senha);
      await iniciarApp();
    } catch (er) {
      mostrarErro(er.message);
    } finally {
      b.disabled = false; b.textContent = 'Criar conta';
    }
  };
}

async function iniciarApp() {
  $('#auth').hidden = true;
  $('#splash').hidden = false;
  try {
    await carregarTudo();
  } catch (e) {
    toast('Falha ao carregar dados: ' + e.message, 'erro');
  }
  $('#splash').hidden = true;
  $('#app').hidden = false;
  render();
}

(async function arranque() {
  prepararLogin();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  if (sb.temSessao()) {
    await iniciarApp();
  } else {
    $('#splash').hidden = true;
    $('#auth').hidden = false;
  }
})();
