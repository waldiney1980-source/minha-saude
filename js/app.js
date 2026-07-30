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
  avaliacaoIA: localStorage.getItem('saude.avaliacao') || '',
  avaliacaoQuando: localStorage.getItem('saude.avaliacaoQuando') || '',
};

async function carregarTudo() {
  const [perfil, medidas, exames, refeicoes, atividades] = await Promise.all([
    sb.listar('sau_perfil', 'select=*&limit=1'),
    sb.listar('sau_medidas', 'select=*&order=data.desc,criado_em.desc&limit=500'),
    sb.listar('sau_exames', 'select=*&order=data.desc,criado_em.desc&limit=1000'),
    sb.listar('sau_refeicoes', 'select=*&order=quando.desc&limit=800'),
    sb.listar('sau_atividades', 'select=*&order=data.desc&limit=800'),
  ]);
  st.perfil = (perfil && perfil[0]) || null;
  st.medidas = medidas || [];
  st.exames = exames || [];
  st.refeicoes = refeicoes || [];
  st.atividades = atividades || [];
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

const imc = () => {
  const p = pesoAtual(), a = num(st.perfil?.altura_cm);
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
  const p = pesoAtual(), a = num(st.perfil?.altura_cm), i = idade(), s = st.perfil?.sexo;
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

  v.innerHTML = `
    <section class="cartao resumo">
      <div class="resumo__anel" style="--pct:${pct}">
        <div class="resumo__miolo"><b>${Math.round(consumido)}</b><span>kcal</span></div>
      </div>
      <div class="resumo__info">
        <p><b>Meta:</b> ${meta ? kcal(meta) : '<a href="#" data-ir="perfil">complete o perfil</a>'}</p>
        <p><b>Atividade:</b> ${kcal(gastoAtv)} gastos</p>
        ${restante != null ? `<p class="${restante < 0 ? 'texto-ruim' : 'texto-bom'}">${restante >= 0 ? `Restam ${kcal(restante)}` : `${kcal(-restante)} acima da meta`}</p>` : ''}
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
  $$('[data-ir]', v).forEach((a) => a.onclick = (e) => { e.preventDefault(); irPara(a.dataset.ir); });
  ligarListas(v);
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

      <label>Calorias (kcal) — pode editar manualmente
        <input name="calorias" inputmode="decimal" required value="${r ? Math.round(r.calorias) : ''}" placeholder="ex.: 650">
      </label>

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
        <button class="btn btn--mini" id="add-exame">+ Lançar exame</button>
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
  $$('[data-ex]', v).forEach((li) => li.onclick = () => {
    const e = st.exames.find((x) => x.id === li.dataset.ex);
    if (e) modalExame(e);
  });
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

  $('#b-avaliar', v).onclick = async () => {
    const b = $('#b-avaliar', v);
    b.disabled = true; b.textContent = 'Analisando…';
    try {
      const resp = await sb.ia({ acao: 'avaliacao', dados: dadosParaIA() }, 120000);
      st.avaliacaoIA = resp.avaliacao || '';
      st.avaliacaoQuando = new Date().toLocaleString('pt-BR');
      localStorage.setItem('saude.avaliacao', st.avaliacaoIA);
      localStorage.setItem('saude.avaliacaoQuando', st.avaliacaoQuando);
      $('#ia-saida', v).innerHTML = md(st.avaliacaoIA) + `<p class="nota">Gerada em ${st.avaliacaoQuando}.</p>`;
    } catch (e) {
      toast('Não consegui gerar a análise: ' + e.message, 'erro');
    } finally {
      b.disabled = false; b.textContent = '✨ Gerar análise';
    }
  };
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
          <label>Altura (cm) <input name="altura" inputmode="decimal" value="${p.altura_cm || ''}"></label>
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
        altura_cm: num(f.altura.value),
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

  $('#b-sair', v).onclick = async () => {
    if (!confirm('Sair da conta?')) return;
    await sb.sair();
    location.reload();
  };
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
