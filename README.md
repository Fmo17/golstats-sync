# Futebol Analytics — Setup inicial

## 1. Criar projeto Supabase

Crie um projeto novo (separado do Fênix e do Super Trunfo) e rode o
`sql/schema.sql` no SQL Editor do Supabase pra criar todas as tabelas.

## 2. Pegar a API key da API-Football

1. Crie conta grátis em https://dashboard.api-football.com
2. Copie sua API key (plano Free = 100 requisições/dia)

## 3. Configurar variáveis de ambiente (arquivo .env)

Copie o arquivo de exemplo e preencha com seus valores reais:

```bash
cp .env.example .env
```

Abra o `.env` num editor de texto e preencha:

```
API_FOOTBALL_KEY=sua_chave_aqui
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=sua_service_role_key
```

O `.env` já está no `.gitignore` -- nunca vai ser enviado ao GitHub, mesmo
se você fizer commit de tudo o resto do projeto. **Nunca cole o conteúdo
desse arquivo em chat, print, ou qualquer lugar público.**

## 4. Instalar dependências

```bash
npm install
```

## 5. Primeiro passo: listar competições reais do Brasil

Antes de rodar o sync de verdade, rode isso pra confirmar os IDs exatos
de cada competição na API-Football (os IDs no `sync.js` são um ponto de
partida, mas precisam ser confirmados):

```bash
npm run sync:listar
```

Isso vai imprimir todas as competições do Brasil com seus IDs reais.
Ajuste o array `COMPETICOES_SEED` em `scripts/sync.js` com os IDs corretos
antes do próximo passo.

## 6. Rodar o sync

```bash
npm run sync
```

Isso vai:
- Criar/atualizar as competições configuradas na tabela `competicoes`
- Buscar os jogos (fixtures) de cada uma
- Gravar times e partidas no Supabase
- Registrar tudo em `sync_log` (útil pra acompanhar quota gasta)

## Próximos passos (ainda não implementados neste script)

- [ ] Sync de estatísticas por partida (após jogo finalizado)
- [ ] Sync de odds (snapshot histórico)
- [ ] Cálculo de sinais (probabilidade do modelo vs. odd de mercado)
- [ ] Cálculo de `estatisticas_modelo` (taxa de acerto histórica por tipo de sinal)
- [ ] Automação via GitHub Actions (cron)
