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
 *   node scripts/sync.js --stats --limite=80                 -> sync de estatísticas, rodízio entre todas
 *   node scripts/sync.js --stats --limite=10 --competicao=71 -> sync de estatísticas só de 1 competição (útil pra testar xG)
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
  // Serie C removida em 10/09/2026, Copa do Nordeste/Carioca/Mineiro/Gaúcho/
  // Serie D removidas em 15/09/2026, e Paulista removida logo em seguida --
  // API-Football confirmadamente não tem (ou tem muito pouco) dado de
  // estatística disponível pra essas competições, mesmo depois de esgotar
  // a fila de tentativas.

  // Ligas internacionais -- IDs confirmados via scripts/checar-cobertura-paises.js
  { nome: 'Bundesliga', api_football_id: 78, tipo: 'nacional', prioridade: 'alta', pais: 'Germany' },
  { nome: 'Serie A Itália', api_football_id: 135, tipo: 'nacional', prioridade: 'alta', pais: 'Italy' },
  { nome: 'Ligue 1', api_football_id: 61, tipo: 'nacional', prioridade: 'alta', pais: 'France' },
  { nome: 'La Liga', api_football_id: 140, tipo: 'nacional', prioridade: 'alta', pais: 'Spain' },
  { nome: 'Premier League', api_football_id: 39, tipo: 'nacional', prioridade: 'alta', pais: 'England' },
  { nome: 'Primeira Liga', api_football_id: 94, tipo: 'nacional', prioridade: 'media', pais: 'Portugal' },
  { nome: 'MLS', api_football_id: 253, tipo: 'nacional', prioridade: 'media', pais: 'USA' },
  { nome: 'Pro League Saudita', api_football_id: 307, tipo: 'nacional', prioridade: 'media', pais: 'Saudi-Arabia' },
  { nome: 'Liga Profesional Argentina', api_football_id: 128, tipo: 'nacional', prioridade: 'media', pais: 'Argentina' },
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
        pais: comp.pais || 'Brazil',
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

  // A própria resposta de fixtures já traz o logo da competição
  // (fx.league.logo) -- mesmo objeto de onde já tirávamos "rodada". Não
  // precisa de nenhuma chamada extra à API pra isso.
  const logoUrl = fixtures[0]?.league?.logo;
  if (logoUrl) {
    const { error: erroLogo } = await supabase
      .from('competicoes')
      .update({ logo_url: logoUrl })
      .eq('id', competicao.id);
    if (erroLogo) console.error(`  Erro ao gravar logo de ${competicao.nome}:`, erroLogo.message);
  }

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
  // Códigos reais da API-Football (documentação de fixture status).
  const finalizados = ['FT', 'AET', 'PEN', 'AWD', 'WO']; // inclui vitória por W.O. e decisão administrativa -- têm resultado definido
  const aoVivo = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE', 'BT', 'SUSP', 'INT'];
  const cancelados = ['PST', 'CANC', 'ABD', 'TBD']; // adiado, cancelado, abandonado, sem data definida -- NUNCA deve virar "agendado"

  if (finalizados.includes(shortStatus)) return 'finalizado';
  if (aoVivo.includes(shortStatus)) return 'ao_vivo';
  if (cancelados.includes(shortStatus)) return 'cancelado';
  return 'agendado'; // só "NS" (not started) e códigos desconhecidos caem aqui -- jogo realmente futuro
}

/**
 * Corrige retroativamente jogos que já ficaram presos como "agendado" no
 * passado (dado antigo, sincronizado antes dessa correção existir). Marca
 * como "cancelado" os que não têm placar, e "finalizado" os que têm.
 */
async function corrigirAgendadosDoPassado() {
  const agora = new Date().toISOString();
  const { data: presos, error } = await supabase
    .from('partidas')
    .select('id, gols_casa, gols_fora')
    .eq('status', 'agendado')
    .lt('data_hora', agora);

  if (error) throw error;
  if (!presos || presos.length === 0) {
    console.log('Nenhum jogo "agendado do passado" encontrado -- nada pra corrigir.');
    return;
  }

  console.log(`Encontrados ${presos.length} jogos "agendado" com data no passado. Corrigindo...`);

  let corrigidosFinalizado = 0;
  let corrigidosCancelado = 0;

  for (const p of presos) {
    const novoStatus = p.gols_casa !== null && p.gols_fora !== null ? 'finalizado' : 'cancelado';
    const { error: errUpdate } = await supabase.from('partidas').update({ status: novoStatus }).eq('id', p.id);
    if (errUpdate) {
      console.error(`  Erro ao corrigir partida ${p.id}:`, errUpdate.message);
      continue;
    }
    if (novoStatus === 'finalizado') corrigidosFinalizado++;
    else corrigidosCancelado++;
  }

  console.log(`  -> ${corrigidosFinalizado} corrigidos pra "finalizado" (tinham placar)`);
  console.log(`  -> ${corrigidosCancelado} corrigidos pra "cancelado" (sem placar registrado)`);
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
  if (typeof item.value === 'number') return item.value;
  const convertido = parseFloat(item.value);
  return Number.isNaN(convertido) ? null : convertido;
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
 *
 * @param {number} limite - máximo de partidas processadas nessa execução
 * @param {number|null} apenasCompeticaoApiId - se informado, ignora o
 *   rodízio e busca SÓ dessa competição (útil pra testar um campo novo,
 *   tipo xG, numa competição específica antes de rodar em todas)
 */
async function syncEstatisticas(limite = 80, apenasCompeticaoApiId = null, pausaEntreChamadas = 1000) {
  console.log(`\nBuscando partidas finalizadas sem estatísticas (limite: ${limite}${apenasCompeticaoApiId ? `, só competição ${apenasCompeticaoApiId}` : ', em rodízio entre competições'})...`);

  let queryCompeticoes = supabase.from('competicoes').select('id, nome, api_football_id').eq('ativa', true);
  if (apenasCompeticaoApiId) queryCompeticoes = queryCompeticoes.eq('api_football_id', apenasCompeticaoApiId);

  const { data: competicoesAtivas, error: errComp } = await queryCompeticoes;
  if (errComp) throw errComp;

  // IMPORTANTE: o Supabase corta silenciosamente em 1000 linhas se não
  // especificarmos um range -- com a tabela já passando disso, isso causava
  // duplicação (o script "esquecia" que partidas antigas já tinham
  // estatística, e reprocessava). Pagina em blocos de 1000 até esgotar.
  const idsComStats = new Set();
  {
    let pagina = 0;
    const TAMANHO_PAGINA = 1000;
    while (true) {
      const { data: blocoStats, error: errStats } = await supabase
        .from('estatisticas_partida')
        .select('partida_id')
        .range(pagina * TAMANHO_PAGINA, pagina * TAMANHO_PAGINA + TAMANHO_PAGINA - 1);
      if (errStats) throw errStats;
      if (!blocoStats || blocoStats.length === 0) break;

      for (const s of blocoStats) idsComStats.add(s.partida_id);

      if (blocoStats.length < TAMANHO_PAGINA) break; // última página
      pagina++;
    }
  }
  console.log(`  (${idsComStats.size} partidas já têm estatística registrada, buscadas com paginação completa)`);

  // Busca as partidas pendentes de CADA competição separadamente (mais
  // recentes primeiro dentro de cada uma).
  const pendentesPorCompeticao = [];
  for (const comp of competicoesAtivas) {
    let partidasDaCompeticao = [];
    let pagina = 0;
    const TAMANHO_PAGINA_PARTIDAS = 1000;
    while (true) {
      const { data: bloco, error: errP } = await supabase
        .from('partidas')
        .select('id, api_football_id, time_casa_id, time_fora_id')
        .eq('competicao_id', comp.id)
        .eq('status', 'finalizado')
        .order('data_hora', { ascending: false })
        .range(pagina * TAMANHO_PAGINA_PARTIDAS, pagina * TAMANHO_PAGINA_PARTIDAS + TAMANHO_PAGINA_PARTIDAS - 1);
      if (errP) throw errP;
      if (!bloco || bloco.length === 0) break;
      partidasDaCompeticao = partidasDaCompeticao.concat(bloco);
      if (bloco.length < TAMANHO_PAGINA_PARTIDAS) break;
      pagina++;
    }

    const pendentes = partidasDaCompeticao.filter((p) => !idsComStats.has(p.id));
    if (pendentes.length > 0) {
      pendentesPorCompeticao.push({ nome: comp.nome, fila: pendentes });
    }
  }

  console.log('  Pendentes por competição:');
  for (const c of pendentesPorCompeticao) console.log(`    ${c.nome}: ${c.fila.length} partidas`);

  // Rodízio: pega 1 partida de cada competição por vez, até atingir o limite
  // ou esgotar todas as filas. Com apenas 1 competição na lista (modo teste),
  // isso vira simplesmente "as N mais recentes daquela competição".
  const pendentes = [];
  let indice = 0;
  while (pendentes.length < limite) {
    const algumaFilaTemItem = pendentesPorCompeticao.some((c) => c.fila.length > 0);
    if (!algumaFilaTemItem) break;

    const c = pendentesPorCompeticao[indice % pendentesPorCompeticao.length];
    if (c.fila.length > 0) pendentes.push(c.fila.shift());
    indice++;
  }

  console.log(`  ${pendentes.length} partidas selecionadas pra essa execução`);
  console.log(`  IDs internos (partida_id) selecionados: ${pendentes.map((p) => p.id).join(', ')}`);

  let processadas = 0;
  let comXgPreenchido = 0;
  let gravacoesComSucesso = 0;
  let errosGravacao = 0;
  let semDadoDisponivel = 0;

  for (const partida of pendentes) {
    try {
      // No plano Free, o limite era 10 req/min (por isso a pausa de 6.5s).
      // No plano pago, o limite por minuto é maior -- reduzimos a pausa, e
      // contamos com o retry automático em caso de 429 (rate limit) como
      // rede de segurança, caso ainda seja baixo demais.
      await sleep(pausaEntreChamadas);

      const response = await apiFetch('fixtures/statistics', { fixture: partida.api_football_id });

      if (!response || response.length === 0) {
        // A API não tem estatística pra esse jogo -- registra uma "tentativa
        // vazia" (todos os campos null) pros 2 times, só pra NUNCA MAIS
        // tentar de novo esse jogo em execuções futuras (economiza cota).
        // Não conta como cobertura real, porque checar-cobertura-stats.js só
        // conta linhas com campo preenchido -- essas ficam de fora da conta.
        semDadoDisponivel++;
        for (const timeId of [partida.time_casa_id, partida.time_fora_id]) {
          await supabase.from('estatisticas_partida').insert({
            partida_id: partida.id,
            time_id: timeId,
            posse_bola: null,
            finalizacoes: null,
            finalizacoes_no_gol: null,
            escanteios: null,
            cartoes_amarelos: null,
            cartoes_vermelhos: null,
            xg: null,
          });
        }
        processadas++;
        continue;
      }

      for (const teamStats of response) {
        const { data: timeLocal } = await supabase
          .from('times')
          .select('id')
          .eq('api_football_id', teamStats.team.id)
          .single();

        if (!timeLocal) continue;

        const stats = teamStats.statistics;
        const xg = extrairStat(stats, 'Expected Goals');
        if (xg !== null) comXgPreenchido++;

        const { error: erroInsert } = await supabase.from('estatisticas_partida').insert({
          partida_id: partida.id,
          time_id: timeLocal.id,
          posse_bola: extrairStat(stats, 'Ball Possession'),
          finalizacoes: extrairStat(stats, 'Total Shots'),
          finalizacoes_no_gol: extrairStat(stats, 'Shots on Goal'),
          escanteios: extrairStat(stats, 'Corner Kicks'),
          cartoes_amarelos: extrairStat(stats, 'Yellow Cards'),
          cartoes_vermelhos: extrairStat(stats, 'Red Cards'),
          xg: xg,
        });

        if (erroInsert) {
          errosGravacao++;
          console.error(`  Erro ao GRAVAR estatística (partida ${partida.api_football_id}, time ${timeLocal.id}):`, erroInsert.message);
        } else {
          gravacoesComSucesso++;
        }
      }

      processadas++;
    } catch (err) {
      console.error(`  Erro na partida ${partida.api_football_id}:`, err.message);
    }
  }

  console.log(`  -> ${processadas} partidas processadas (resposta da API recebida)`);
  console.log(`  -> ${semDadoDisponivel} sem estatística disponível na API (marcadas -- não serão tentadas de novo)`);
  console.log(`  -> ${gravacoesComSucesso} registros de estatística GRAVADOS com sucesso no banco`);
  if (errosGravacao > 0) {
    console.log(`  -> ⚠️  ${errosGravacao} registros FALHARAM ao gravar (ver mensagens de erro acima)`);
  }
  console.log(`  -> xG veio preenchido em ${comXgPreenchido} dos ${gravacoesComSucesso} registros gravados (${gravacoesComSucesso > 0 ? ((comXgPreenchido / gravacoesComSucesso) * 100).toFixed(1) : 0}%)`);
  await logSync('fixtures/statistics', null, 'sucesso', `${processadas} partidas, xG em ${comXgPreenchido}`);
  return processadas;
}

/**
 * Fluxo principal: sincroniza as competições configuradas.
 */
async function main() {
  const args = process.argv.slice(2);
  const listarFlag = args.includes('--listar');
  const statsFlag = args.includes('--stats');
  const corrigirFlag = args.includes('--corrigir-agendados');
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const limiteArg = args.find((a) => a.startsWith('--limite='));

  if (listarFlag) {
    await listarCompeticoesBrasil();
    console.log(`\nTotal de requisições usadas: ${requisicoesUsadas}`);
    return;
  }

  if (corrigirFlag) {
    await corrigirAgendadosDoPassado();
    return;
  }

  if (statsFlag) {
    const limite = limiteArg ? parseInt(limiteArg.split('=')[1], 10) : 80;
    const apenasCompeticaoApiId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : null;
    const pausaArg = args.find((a) => a.startsWith('--pausa='));
    const pausaEntreChamadas = pausaArg ? parseInt(pausaArg.split('=')[1], 10) : 1000;
    await syncEstatisticas(limite, apenasCompeticaoApiId, pausaEntreChamadas);
    console.log(`\n=== Sync de estatísticas finalizado. Requisições usadas: ${requisicoesUsadas} ===`);
    return;
  }

  console.log('=== Iniciando sync ===\n');

  let competicoesParaSync = COMPETICOES_SEED;
  if (competicaoArg) {
    const id = parseInt(competicaoArg.split('=')[1], 10);
    competicoesParaSync = COMPETICOES_SEED.filter((c) => c.api_football_id === id);
  }

  // Controle de quais temporadas sincronizar, priorizando SEMPRE o mais
  // recente primeiro -- pra cobrir todas as ligas com dado atual antes de
  // "aprofundar" pros anos antigos (evita gastar toda a cota numa liga só).
  //
  //   node scripts/sync.js                        -> só a temporada atual (2026), todas as ligas
  //   node scripts/sync.js --temporada=2025        -> só 2025, todas as ligas
  //   node scripts/sync.js --temporada=2025,2024   -> 2025 e 2024, todas as ligas
  //   node scripts/sync.js --todas-temporadas      -> 2010 até 2026 (uso pontual, é bastante chamada)
  const TEMPORADA_ATUAL = 2026;
  const temporadaArg = args.find((a) => a.startsWith('--temporada='));
  const todasTemporadasFlag = args.includes('--todas-temporadas');

  let temporadasParaSync;
  if (todasTemporadasFlag) {
    temporadasParaSync = [];
    for (let ano = TEMPORADA_ATUAL; ano >= 2010; ano--) temporadasParaSync.push(ano);
  } else if (temporadaArg) {
    temporadasParaSync = temporadaArg.split('=')[1].split(',').map((a) => parseInt(a, 10));
  } else {
    temporadasParaSync = [TEMPORADA_ATUAL];
  }

  console.log(`Temporadas nessa execução: ${temporadasParaSync.join(', ')}\n`);

  // Loop por TEMPORADA primeiro, depois por liga -- assim, se a execução for
  // interrompida no meio, todas as ligas já têm pelo menos a temporada mais
  // recente sincronizada, em vez de uma liga só ter todas e as outras nenhuma.
  for (const temporada of temporadasParaSync) {
    for (const compSeed of competicoesParaSync) {
      try {
        const comp = await upsertCompeticao({ ...compSeed, temporada });
        const totalJogos = await syncFixtures(comp);
        await logSync('fixtures', comp.id, 'sucesso', `temporada ${temporada}: ${totalJogos} jogos`);
      } catch (err) {
        console.error(`Erro ao sincronizar ${compSeed.nome} (temporada ${temporada}):`, err.message);
        await logSync('fixtures', null, 'erro', `temporada ${temporada}: ${err.message}`);
      }
      await sleep(1000); // pequena folga entre chamadas, mesmo no plano pago
    }
  }

  console.log(`\n=== Sync finalizado. Requisições usadas: ${requisicoesUsadas} ===`);
}

main().catch((err) => {
  console.error('Erro fatal no sync:', err);
  process.exit(1);
});
