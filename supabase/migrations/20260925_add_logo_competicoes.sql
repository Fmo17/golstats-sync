-- Adiciona a coluna de logo nas competições -- a API-Football já fornece
-- essa URL (league.logo), só nunca gravamos.

alter table competicoes
  add column if not exists logo_url text;

comment on column competicoes.logo_url is 'URL do logo da competição, fornecido pela API-Football (league.logo)';
