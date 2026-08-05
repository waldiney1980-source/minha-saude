-- Minha Saúde — estrutura no Supabase (aplicada como migração "saude_app_tabelas").
-- Dados estritamente pessoais: RLS por auth.uid().

create table if not exists public.sau_perfil (
  user_id        uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  nome           text not null default '',
  nascimento     date,
  sexo           text not null default '',
  altura_cm      numeric,
  nivel_atividade text not null default 'leve',
  objetivo       text not null default 'manter',
  meta_calorias  integer,
  updated_at     timestamptz not null default now()
);

create table if not exists public.sau_medidas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data date not null default current_date,
  peso_kg numeric,
  pressao_sist integer,
  pressao_diast integer,
  obs text not null default '',
  criado_em timestamptz not null default now()
);

create table if not exists public.sau_exames (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data date not null default current_date,
  exame text not null,
  valor numeric not null,
  unidade text not null default '',
  ref_min numeric,
  ref_max numeric,
  obs text not null default '',
  criado_em timestamptz not null default now()
);

create table if not exists public.sau_refeicoes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  quando timestamptz not null default now(),
  tipo text not null default 'lanche',
  descricao text not null default '',
  calorias numeric not null default 0,
  proteinas_g numeric,
  carboidratos_g numeric,
  gorduras_g numeric,
  origem text not null default 'manual',
  itens jsonb,
  foto text,
  criado_em timestamptz not null default now()
);

create table if not exists public.sau_atividades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data date not null default current_date,
  tipo text not null default '',
  duracao_min integer not null default 0,
  calorias numeric,
  obs text not null default '',
  criado_em timestamptz not null default now()
);

create table if not exists public.sau_agua (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  quando timestamptz not null default now(),
  ml integer not null,
  criado_em timestamptz not null default now()
);

-- Resumo diário vindo do app Saúde / Apple Watch (uma linha por usuário e dia).
create table if not exists public.sau_diario (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data                 date not null default current_date,
  passos               integer,
  distancia_km         numeric,
  fc_repouso           integer,
  fc_media             integer,
  sono_min             integer,
  energia_repouso_kcal numeric,
  energia_ativa_kcal   numeric,
  exercicio_min        integer,
  de_pe_h              integer,
  fonte                text not null default 'Apple Watch',
  atualizado_em        timestamptz not null default now(),
  criado_em            timestamptz not null default now(),
  constraint sau_diario_user_data unique (user_id, data)
);

-- Colunas usadas pela integração do atalho do iPhone.
alter table public.sau_perfil     add column if not exists atalho_token   text;
alter table public.sau_perfil     add column if not exists atalho_sync_em timestamptz;
alter table public.sau_atividades add column if not exists uid            text;

create index if not exists sau_medidas_user_data     on public.sau_medidas    (user_id, data);
create index if not exists sau_exames_user_data      on public.sau_exames     (user_id, data);
create index if not exists sau_refeicoes_user_quando on public.sau_refeicoes  (user_id, quando);
create index if not exists sau_atividades_user_data  on public.sau_atividades (user_id, data);
create index if not exists sau_agua_user_quando      on public.sau_agua       (user_id, quando);

alter table public.sau_agua       enable row level security;
alter table public.sau_diario     enable row level security;
alter table public.sau_perfil     enable row level security;
alter table public.sau_medidas    enable row level security;
alter table public.sau_exames     enable row level security;
alter table public.sau_refeicoes  enable row level security;
alter table public.sau_atividades enable row level security;

do $$
declare t text;
begin
  foreach t in array array['sau_perfil','sau_medidas','sau_exames','sau_refeicoes','sau_atividades','sau_agua','sau_diario'] loop
    execute format('drop policy if exists %I on public.%I', t || '_dono', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_dono', t
    );
  end loop;
end $$;
