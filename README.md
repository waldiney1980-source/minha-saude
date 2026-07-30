# Minha Saúde

PWA de controle pessoal de saúde: exames de laboratório, alimentação (com cálculo de
calorias por foto usando IA), atividade física, evolução de peso e um painel de
indicadores com avaliação completa gerada por IA.

> ⚠️ O aplicativo é informativo e **não substitui** consulta, diagnóstico ou tratamento médico.

## Como funciona

- **App**: HTML/CSS/JS puro (sem build), instalável como PWA (`manifest.webmanifest` + `sw.js`).
- **Backend**: Supabase (projeto `mhqhbnfbfrfsckhcvzis`, o mesmo dos outros apps).
  - Tabelas `sau_perfil`, `sau_medidas`, `sau_exames`, `sau_refeicoes`, `sau_atividades`
    (ver `db/supabase.sql`). RLS garante que **cada usuário só enxerga os próprios dados**.
  - Edge Function `saude-ia` (`supabase/functions/saude-ia/index.ts`):
    - `acao: "refeicao"` — recebe a foto do prato e devolve itens + calorias estimadas;
    - `acao: "avaliacao"` — recebe perfil/exames/hábitos e devolve avaliação em Markdown.
    - Usa `GOOGLE_API_KEY` (Gemini) ou `ANTHROPIC_API_KEY` — segredos já configurados no projeto.
- **Login**: e-mail/senha do Supabase Auth (mesmas contas dos demais apps).

## Publicação

GitHub Pages, como os outros projetos:

```bash
git push origin main main:gh-pages
```

## Desenvolvimento local

Qualquer servidor estático serve, por exemplo:

```bash
python3 -m http.server 8788
```
