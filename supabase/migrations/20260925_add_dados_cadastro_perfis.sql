-- Adiciona os campos de cadastro completo na tabela perfis -- hoje ela só
-- tem email/nome/plano/ativo/is_admin, sem os dados pessoais completos.

alter table perfis
  add column if not exists documento_tipo text check (documento_tipo in ('CPF', 'RG', 'Outro')),
  add column if not exists documento_outro_descricao text,
  add column if not exists documento_numero text,
  add column if not exists data_nascimento date,
  add column if not exists estado text,
  add column if not exists cidade text,
  add column if not exists telefone text,
  add column if not exists telefone_whatsapp boolean default false;

comment on column perfis.documento_tipo is 'CPF, RG, ou Outro -- se Outro, ver documento_outro_descricao';
comment on column perfis.documento_outro_descricao is 'Descrição de qual documento é, preenchido só quando documento_tipo = Outro';
comment on column perfis.telefone_whatsapp is 'Se o telefone de contato também é WhatsApp';
