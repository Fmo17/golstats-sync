/**
 * sync.js
 * Busca dados da API-Football e grava no Supabase.
 * Pensado pra rodar via GitHub Actions (cron) ou manualmente.
 *
 * Variáveis de ambiente necessárias:
 *   API_FOOTBALL_KEY   -> chave da api-football.com
 *   SUPABASE_URL       -> URL do projeto Supabase
 *   SUPABASE_KEY       -> service_role key (não a anon key, precisa de write)
 *
 * Uso:
 *   node scripts/sync.js                 -> roda sync padrão (competições ativas)
 *   node scripts/sync.js --competicao=71  -> roda só uma competição (id da api-football)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!API_FOOTBALL_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltam variáveis de ambiente. Necessário: API_FOOTBALL_KEY, SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const API_BASE = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_FOOTBALL_KEY };

let requisicoesUsadas = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// IDs confirmados via `npm run sync:listar` em 17/07/2026.
const COMPETICOES_SEED = [
  // Alta prioridade: sync diário
  { nome: 'Brasileirão Série A', api_football_id: 71, tipo: 'nacional', prioridade: 'alta' },
  { nome: 'Brasileirão Série B', api_football_id: 72, tipo: 'nacional', prioridade: 'alta' },
  { nome: 'Copa do Brasil', api_football_id: 73, tipo: 'copa', prioridade: 'alta' },

  // Média prioridade: sync a cada 2-3 dias
  { nome: 'Serie C', api_football_id: 75, tipo: 'nacional', prioridade: 'media' },
  { nome: 'Copa do Nordeste', api_football_id: 612, tipo: 'copa', prioridade: 'media' },
  { nome: 'Paulista - A1', api_football_id: 475, tipo: 'estadual', prioridade: 'media' },
  { nome: 'Carioca - 1', api_football_id: 624, tipo: 'estadual', prioridade: 'media' },
  { nome: 'Mineiro - 1', api_football_id: 629, tipo: 'estadual', prioridade: 'media' },
  { nome: 'Gaúcho - 1', api_football_id: 477, tipo: 'estadual', prioridade: 'media' },

  // Baixa prioridade: sync semanal
  { nome: 'Serie D', api_football_id: 76, tipo: 'nacional', prioridade: 'baixa' },
];

// Estaduais adicionais disponíveis, caso queira expandir depois:
// Baiano-1: 602, Catarinense-1: 604, Paranaense-1: 606, Pernambucano-1: 622,
// Goiano-1: 628, Cearense-1: 609, Paraibano: 603, e mais 20 estados na lista completa.

async function apiFetch(endpoint, params = {}, tentativa = 1) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, { headers: HEADERS });
  requisicoesUsadas++;

  if (res.status === 429 && tentativa <= 2) {
    console.log(`  Rate limit atingido, aguardando 15s antes de tentar de novo (tentativa ${tentativa})...`);
    await sleep(15000);
    return apiFetch(endpoint, params, tentativa + 1);
  }

  if (!res.ok) {
    throw new Error(`Erro na API-Football: ${res.status} ${res.statusText} (${endpoint})`);
  }

  const data = await res.json();

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football retornou erro: ${JSON.stringify(data.errors)}`);
  }

  return data.response;
}

async function logSync(endpoint, competicaoId, status, detalhes = '') {
  await supabase.from('sync_log').insert({
    endpoint,
    competicao_id: competicaoId,
    requisicoes_usadas: requisicoesUsadas,
    status,
    detalhes,
  });
}

/**
 * Descobre automaticamente todas as ligas/copas do Brasil disponíveis na API.
 * Útil pra rodar 1x e ver a lista completa de IDs antes de decidir quais
 * competições ativar no seu banco.
 */
async function listarCompeticoesBrasil() {
  console.log('Buscando todas as competições do Brasil na API-Football...');
  const leagues = await apiFetch('leagues', { country: 'Brazil' });

  console.log(`\nEncontradas ${leagues.length} competições:\n`);
  leagues.forEach((l) => {
    console.log(`  ID ${l.league.id} — ${l.league.name} (${l.league.type})`);
  });

  return leagues;
}

/**
 * Garante que a competição existe na tabela `competicoes`, criando se necessário.
 */
async function upsertCompeticao(comp) {
  const { data, error } = await supabase
    .from('competicoes')
    .upsert(
      {
        api_football_id: comp.api_football_id,
        nome: comp.nome,
        tipo: comp.tipo || 'nacional',
        pais: 'Brazil',
        temporada: comp.temporada || new Date().getFullYear(),
        prioridade: comp.prioridade || 'media',
        ativa: true,
        ultima_atualizacao: new Date().toISOString(),
      },
      { onConflict: 'api_football_id' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function upsertTime(timeApi) {
  const { data, error } = await supabase
    .from('times')
    .upsert(
      {
        api_football_id: timeApi.id,
        nome: timeApi.name,
        sigla: timeApi.code || null,
        escudo_url: timeApi.logo || null,
      },
      { onConflict: 'api_football_id' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Busca fixtures (jogos) de uma competição e grava no banco.
 */
async function syncFixtures(competicao) {
  console.log(`Sincronizando jogos: ${competicao.nome}...`);

  const fixtures = await apiFetch('fixtures', {
    league: competicao.api_football_id,
    season: competicao.temporada,
  });

  for (const fx of fixtures) {
    const timeCasa = await upsertTime(fx.teams.home);
    const timeFora = await upsertTime(fx.teams.away);

    const { error } = await supabase.from('partidas').upsert(
      {
        api_football_id: fx.fixture.id,
        competicao_id: competicao.id,
        time_casa_id: timeCasa.id,
        time_fora_id: timeFora.id,
        data_hora: fx.fixture.date,
        status: mapStatus(fx.fixture.status.short),
        gols_casa: fx.goals.home,
        gols_fora: fx.goals.away,
        rodada: fx.league.round,
        ultima_atualizacao: new Date().toISOString(),
      },
      { onConflict: 'api_football_id' }
    );

    if (error) console.error(`Erro ao gravar partida ${fx.fixture.id}:`, error.message);
  }

  console.log(`  -> ${fixtures.length} jogos processados`);
  return fixtures.length;
}

function mapStatus(shortStatus) {
  const finalizados = ['FT', 'AET', 'PEN'];
  const aoVivo = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'];

  if (finalizados.includes(shortStatus)) return 'finalizado';
  if (aoVivo.includes(shortStatus)) return 'ao_vivo';
  return 'agendado';
}

/**
 * Extrai um valor numérico de uma lista de estatísticas retornada pela API
 * (formato: [{ type: 'Ball Possession', value: '54%' }, ...]).
 */
function extrairStat(statsArray, tipo) {
  const item = statsArray.find((s) => s.type === tipo);
  if (!item || item.value === null) return null;

  if (typeof item.value === 'string' && item.value.includes('%')) {
    return parseFloat(item.value.replace('%', ''));
  }
  return typeof item.value === 'number' ? item.value : parseFloat(item.value) || null;
}

/**
 * Busca estatísticas de partidas já finalizadas que ainda não têm registro
 * em `estatisticas_partida`, e grava. Respeita um limite de partidas por
 * execução pra não estourar a quota diária (cada partida = 1 requisição).
 *
 * IMPORTANTE: distribui a cota em RODÍZIO entre as competições ativas --
 * antes, a busca pegava só "as 500 mais recentes de todas juntas", o que
 * viciava a cobertura pra sempre a mesma competição (Série A ficou com 31%
 * enquanto Série C ficou com 0%). Agora cada competição recebe uma fatia
 * justa da cota a cada execução, garantindo que todas cresçam juntas.
 */
async function syncEstatisticas(limite = 80) {
  console.log(`\nBuscando partidas finalizadas sem estatísticas (limite: ${limite}, em rodízio entre competições)...`);

  const { data: competicoesAtivas, error: errComp } = await supabase
    .from('competicoes')
    .select('id, nome')
    .eq('ativa', true);
  if (errComp) throw errComp;

  const { data: jaTemStats, error: errStats } = await supabase
    .from('estatisticas_partida')
    .select('partida_id');
  if (errStats) throw errStats;

  const idsComStats = new Set(jaTemStats.map((s) => s.partida_id));

  // Busca as partidas pendentes de CADA competição separadamente (mais
  // recentes primeiro dentro de cada uma).
  const pendentesPorCompeticao = [];
  for (const comp of competicoesAtivas) {
    const { data: partidasDaCompeticao, error: errP } = await supabase
      .from('partidas')
      .select('id, api_football_id, time_casa_id, time_fora_id')
      .eq('competicao_id', comp.id)
      .eq('status', 'finalizado')
      .order('data_hora', { ascending: false })
      .limit(200);
    if (errP) throw errP;

    const pendentes = (partidasDaCompeticao || []).filter((p) => !idsComStats.has(p.id));
    if (pendentes.length > 0) {
      pendentesPorCompeticao.push({ nome: comp.nome, fila: pendentes });
    }
  }

  console.log('  Pendentes por competição:');
  for (const c of pendentesPorCompeticao) console.log(`    ${c.nome}: ${c.fila.length} partidas`);

  // Rodízio: pega 1 partida de cada competição por vez, até atingir o limite
  // ou esgotar todas as filas.
  const pendentes = [];
  let indice = 0;
  while (pendentes.length < limite) {
    const algumaFilaTemItem = pendentesPorCompeticao.some((c) => c.fila.length > 0);
    if (!algumaFilaTemItem) break;

    const c = pendentesPorCompeticao[indice % pendentesPorCompeticao.length];
    if (c.fila.length > 0) pendentes.push(c.fila.shift());
    indice++;
  }

  console.log(`  ${pendentes.length} partidas selecionadas pra essa execução (distribuídas entre competições)`);

  let processadas = 0;
  for (const partida of pendentes) {
    try {
      // Plano Free permite só 10 requisições por minuto -> aguarda 6.5s entre
      // chamadas pra nunca bater no limite (6.5s x 10 = 65s de folga por minuto).
      await sleep(6500);

      const response = await apiFetch('fixtures/statistics', { fixture: partida.api_football_id });

      if (!response || response.length === 0) continue;

      for (const teamStats of response) {
        const timeId = teamStats.team.id === undefined ? null : teamStats.team.id;
        // Descobre se é o time da casa ou de fora comparando api_football_id
        const { data: timeLocal } = await supabase
          .from('times')
          .select('id')
          .eq('api_football_id', teamStats.team.id)
          .single();

        if (!timeLocal) continue;

        const stats = teamStats.statistics;

        await supabase.from('estatisticas_partida').insert({
          partida_id: partida.id,
          time_id: timeLocal.id,
          posse_bola: extrairStat(stats, 'Ball Possession'),
          finalizacoes: extrairStat(stats, 'Total Shots'),
          finalizacoes_no_gol: extrairStat(stats, 'Shots on Goal'),
          escanteios: extrairStat(stats, 'Corner Kicks'),
          cartoes_amarelos: extrairStat(stats, 'Yellow Cards'),
          cartoes_vermelhos: extrairStat(stats, 'Red Cards'),
        });
      }

      processadas++;
    } catch (err) {
      console.error(`  Erro na partida ${partida.api_football_id}:`, err.message);
    }
  }

  console.log(`  -> ${processadas} partidas processadas`);
  await logSync('fixtures/statistics', null, 'sucesso', `${processadas} partidas`);
  return processadas;
}

/**
 * Fluxo principal: sincroniza as competições configuradas.
 */
async function main() {
  const args = process.argv.slice(2);
  const listarFlag = args.includes('--listar');
  const statsFlag = args.includes('--stats');
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const limiteArg = args.find((a) => a.startsWith('--limite='));

  if (listarFlag) {
    await listarCompeticoesBrasil();
    console.log(`\nTotal de requisições usadas: ${requisicoesUsadas}`);
    return;
  }

  if (statsFlag) {
    const limite = limiteArg ? parseInt(limiteArg.split('=')[1], 10) : 80;
    await syncEstatisticas(limite);
    console.log(`\n=== Sync de estatísticas finalizado. Requisições usadas: ${requisicoesUsadas} ===`);
    return;
  }

  console.log('=== Iniciando sync ===\n');

  let competicoesParaSync = COMPETICOES_SEED;
  if (competicaoArg) {
    const id = parseInt(competicaoArg.split('=')[1], 10);
    competicoesParaSync = COMPETICOES_SEED.filter((c) => c.api_football_id === id);
  }

  for (const compSeed of competicoesParaSync) {
    // O plano Free da API-Football libera 3 temporadas: 2022, 2023 e 2024.
    // Sincronizamos as três pra ter mais profundidade histórica (importante
    // pro modelo estatístico ter amostra suficiente) -- todas ficam
    // registradas sob a mesma competição, já que cada partida tem um ID
    // próprio da API, sem conflito entre temporadas.
    const TEMPORADAS_DISPONIVEIS_FREE = [2022, 2023, 2024];

    for (const temporada of TEMPORADAS_DISPONIVEIS_FREE) {
      try {
        const comp = await upsertCompeticao({ ...compSeed, temporada });
        const totalJogos = await syncFixtures(comp);
        await logSync('fixtures', comp.id, 'sucesso', `temporada ${temporada}: ${totalJogos} jogos`);
      } catch (err) {
        console.error(`Erro ao sincronizar ${compSeed.nome} (temporada ${temporada}):`, err.message);
        await logSync('fixtures', null, 'erro', `temporada ${temporada}: ${err.message}`);
      }
    }
  }

  console.log(`\n=== Sync finalizado. Requisições usadas: ${requisicoesUsadas} ===`);
}

main().catch((err) => {
  console.error('Erro fatal no sync:', err);
  process.exit(1);
});
