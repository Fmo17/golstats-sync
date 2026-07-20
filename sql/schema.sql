-- ============================================================
-- SCHEMA: Plataforma de Analytics de Futebol Brasileiro
-- ============================================================

-- ---------- MÓDULO 1: DADOS BASE ----------

create table competicoes (
  id serial primary key,
  api_football_id int unique not null,
  nome text not null,                  -- "Brasileirão Série A", "Copa do Nordeste"
  tipo text not null,                  -- 'nacional', 'estadual', 'copa'
  pais text default 'Brazil',
  temporada int not null,
  prioridade text default 'media',     -- 'alta', 'media', 'baixa' -> controla frequência de sync
  ativa boolean default true,
  ultima_atualizacao timestamptz
);

create table times (
  id serial primary key,
  api_football_id int unique not null,
  nome text not null,
  sigla text,
  escudo_url text,
  estado text
);

create table jogadores (
  id serial primary key,
  api_football_id int unique not null,
  nome text not null,
  time_id int references times(id),
  posicao text,
  data_nascimento date,
  nacionalidade text
);

create table partidas (
  id serial primary key,
  api_football_id int unique not null,
  competicao_id int references competicoes(id),
  time_casa_id int references times(id),
  time_fora_id int references times(id),
  data_hora timestamptz not null,
  status text,                         -- 'agendado', 'ao_vivo', 'finalizado'
  gols_casa int,
  gols_fora int,
  rodada text,
  ultima_atualizacao timestamptz
);

create table estatisticas_partida (
  id serial primary key,
  partida_id int references partidas(id),
  time_id int references times(id),
  posse_bola numeric,
  finalizacoes int,
  finalizacoes_no_gol int,
  escanteios int,
  cartoes_amarelos int,
  cartoes_vermelhos int,
  xg numeric
);

create table odds_historico (
  id serial primary key,
  partida_id int references partidas(id),
  casa_apostas text,
  odd_casa numeric,
  odd_empate numeric,
  odd_fora numeric,
  capturado_em timestamptz default now()
);

-- ---------- MÓDULO 2: SINAIS E MODELO (analítico, não recomendação de aposta cega) ----------

-- Cada "sinal" é o output do seu modelo pra uma partida específica:
-- probabilidade calculada vs probabilidade implícita da odd de mercado.
create table sinais (
  id serial primary key,
  partida_id int references partidas(id),
  tipo_mercado text not null,          -- 'resultado_final', 'ambas_marcam', 'over_2.5', etc
  probabilidade_modelo numeric not null,   -- 0 a 1, calculada pelo seu modelo
  odd_mercado numeric,
  probabilidade_implicita numeric,     -- derivada da odd: 1/odd (ajustada por overround)
  divergencia numeric,                 -- probabilidade_modelo - probabilidade_implicita
  nivel_confianca text,                -- 'alta', 'media', 'baixa' -> baseado na divergência e amostra
  pacote_minimo text default 'basico', -- 'basico' ou 'top' -> controla quem vê o sinal
  criado_em timestamptz default now()
);

-- Resultado real de cada sinal, preenchido DEPOIS que a partida acaba.
-- Essencial pra manter taxa de acerto histórica transparente e auditável.
create table sinais_resultado (
  id serial primary key,
  sinal_id int references sinais(id),
  acertou boolean,
  resultado_real text,
  avaliado_em timestamptz default now()
);

-- View materializada (ou tabela recalculada por cron) com taxa de acerto
-- por tipo_mercado + nivel_confianca, sobre janela móvel (ex: últimos 200 sinais).
-- Isso alimenta o disclaimer honesto: "sinais de alta confiança acertaram X% nos últimos N casos".
create table estatisticas_modelo (
  id serial primary key,
  tipo_mercado text not null,
  nivel_confianca text not null,
  janela_amostra int not null,         -- ex: 200
  taxa_acerto numeric not null,        -- 0 a 1
  ev_medio numeric,                    -- valor esperado médio por unidade apostada
  calculado_em timestamptz default now()
);

-- ---------- MÓDULO 3: GESTÃO DE BANCA (ferramenta do próprio assinante) ----------

-- Registro pessoal de banca do assinante -- ele controla, a plataforma só organiza.
create table bancas_assinante (
  id serial primary key,
  usuario_id uuid not null,            -- referência ao auth.users do Supabase
  banca_inicial numeric not null,
  banca_atual numeric not null,
  estrategia_staking text default 'fixo', -- 'fixo', 'proporcional', 'kelly_fracionario'
  criado_em timestamptz default now()
);

create table registros_banca (
  id serial primary key,
  banca_id int references bancas_assinante(id),
  sinal_id int references sinais(id),  -- opcional: qual sinal (se algum) motivou a entrada
  valor_apostado numeric not null,
  resultado text,                      -- 'ganhou', 'perdeu', 'pendente'
  saldo_apos numeric,
  registrado_em timestamptz default now()
);

-- ---------- MÓDULO 4: OPERACIONAL ----------

create table sync_log (
  id serial primary key,
  endpoint text,
  competicao_id int,
  requisicoes_usadas int,
  status text,
  detalhes text,
  executado_em timestamptz default now()
);

-- ---------- ÍNDICES ÚTEIS ----------

create index idx_partidas_competicao on partidas(competicao_id);
create index idx_partidas_data on partidas(data_hora);
create index idx_sinais_partida on sinais(partida_id);
create index idx_odds_partida on odds_historico(partida_id);
create index idx_registros_banca on registros_banca(banca_id);
