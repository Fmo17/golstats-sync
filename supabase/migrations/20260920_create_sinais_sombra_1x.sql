-- Modo sombra -- Dupla 1X calibrada (Platt scaling)
--
-- Tabela ISOLADA, nunca lida pelo frontend, nunca exposta a usuários.
-- Existe só pra acumular 300-500 sinais 1X e medir se a probabilidade
-- calibrada se traduz em vantagem real contra a odd da Bet365 -- sem
-- alterar nada do que já está em produção.
--
-- Reaproveita odds_historico (já append-only, populado por sync-odds.js)
-- como fonte da evolução da odd -- não precisa de tabela de snapshot nova.
--
-- Revisado com o ChatGPT em 2026-09-20 -- ver
-- docs/experimentos/teste-final-1x-2026-09-19.md

create table if not exists sinais_sombra_1x (
  id uuid primary key default gen_random_uuid(),

  partida_id integer not null references partidas(id),
  competicao_id integer not null references competicoes(id),

  -- Rastreabilidade do modelo -- imutável (protegido pelo trigger abaixo)
  modelo_versao text not null default 'platt_1x_v1',
  dataset_hash text not null default 'b5eece395054deb68762540ca0417127773d92c5b83953e5edd4e31ab7102b1e',
  parametro_a numeric not null default 0.6022,
  parametro_b numeric not null default 0.3145,
  limiar numeric not null default 0.65,

  -- As 3 probabilidades -- imutável
  probabilidade_bruta numeric not null,
  probabilidade_platt numeric not null,
  probabilidade_baseline numeric not null,

  -- Odd usada no instante da criação do sinal -- a última captura Bet365
  -- com capturada_em <= criado_em (NUNCA a primeira odd histórica do jogo,
  -- nem uma odd posterior). Chamado "odd_no_sinal" (não "odd_primeira") pra
  -- não confundir com a primeira cotação histórica da partida -- imutável.
  odd_no_sinal numeric,
  odd_no_sinal_em timestamptz,
  bookmaker text not null default 'Bet365',

  criado_em timestamptz not null default now(), -- imutável

  -- Preenchidos só depois que a partida termina -- únicos campos mutáveis
  -- (junto com "status"). Chamado "ultima_odd_pre_jogo", não "fechamento",
  -- porque a coleta 2x/dia não garante estar perto o suficiente do início
  -- pra ser uma closing line de verdade.
  ultima_odd_pre_jogo numeric,
  ultima_odd_pre_jogo_em timestamptz,
  minutos_antes_inicio_ultima_odd numeric, -- intervalo real até o início -- mede a qualidade dessa "última odd"
  resultado boolean, -- true = 1X bateu (green), false = red
  lucro_flat numeric, -- retorno com stake fixa de 1 unidade
  status text not null default 'pendente' check (status in ('pendente', 'finalizado', 'cancelado')),

  -- Nunca mais de 1 sinal sombra por partida, por versão de modelo --
  -- reforça "inserções repetidas devem ser ignoradas, não sobrescritas"
  unique (partida_id, modelo_versao)
);

create index if not exists idx_sinais_sombra_1x_status on sinais_sombra_1x(status);
create index if not exists idx_sinais_sombra_1x_partida on sinais_sombra_1x(partida_id);

-- RLS fechada -- nenhuma política pra anon/authenticated, só service role
-- (usado pelos scripts de automação) tem acesso, porque service role
-- ignora RLS por padrão no Supabase
alter table sinais_sombra_1x enable row level security;
-- (propositalmente nenhuma policy criada aqui -- RLS habilitada + zero
-- policies = acesso negado pra anon/authenticated, só service role passa)

-- ---------- Trigger de imutabilidade ----------
-- RLS sem políticas protege contra o frontend, mas NÃO protege contra a
-- própria automação sobrescrever algo por engano (ex: rodar o gerador de
-- novo sem querer). Esse trigger bloqueia UPDATE nas colunas que devem
-- ser fixadas no momento da criação, mesmo vindo da service role.
create or replace function bloquear_alteracao_sinal_sombra_1x()
returns trigger as $$
begin
  if new.partida_id is distinct from old.partida_id
     or new.competicao_id is distinct from old.competicao_id
     or new.modelo_versao is distinct from old.modelo_versao
     or new.dataset_hash is distinct from old.dataset_hash
     or new.parametro_a is distinct from old.parametro_a
     or new.parametro_b is distinct from old.parametro_b
     or new.limiar is distinct from old.limiar
     or new.probabilidade_bruta is distinct from old.probabilidade_bruta
     or new.probabilidade_platt is distinct from old.probabilidade_platt
     or new.probabilidade_baseline is distinct from old.probabilidade_baseline
     or new.odd_no_sinal is distinct from old.odd_no_sinal
     or new.odd_no_sinal_em is distinct from old.odd_no_sinal_em
     or new.criado_em is distinct from old.criado_em
  then
    raise exception 'sinais_sombra_1x: essa coluna é imutável depois de criada -- tentativa de alterar % bloqueada', tg_argv[0];
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_bloquear_alteracao_sinal_sombra_1x on sinais_sombra_1x;
create trigger trg_bloquear_alteracao_sinal_sombra_1x
  before update on sinais_sombra_1x
  for each row
  execute function bloquear_alteracao_sinal_sombra_1x();

comment on table sinais_sombra_1x is 'Modo sombra do Platt scaling para Dupla 1X -- experimento isolado, nunca exposto ao frontend. Probabilidades, parametros do modelo e odd_no_sinal sao imutaveis (protegidos por trigger). So resultado/status/ultima_odd_pre_jogo podem ser atualizados. Ver docs/experimentos/teste-final-1x-2026-09-19.md';
