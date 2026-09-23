/**
 * scripts/gerar-sinais-sombra-1x.js
 *
 * Modo sombra -- gera sinais de Dupla 1X calibrada (Platt) pra jogos
 * futuros, gravando na tabela isolada sinais_sombra_1x. Não altera nada do
 * que os usuários veem -- essa tabela nunca é lida pelo frontend.
 *
 * Os parâmetros do calibrador (a, b) são os CONGELADOS no teste final
 * aprovado -- não são retreinados aqui. Ver
 * docs/experimentos/teste-final-1x-2026-09-19.md
 *
 * Baseline por competição: computado a partir de TODO o histórico
 * disponível até agora (não um recorte fixo de treino/validação/teste --
 * esse split só existia pra provar o método; em produção, usa-se o
 * histórico completo acumulado, igual a calibração normal já faz).
 *
 * Uso:
 *   node scripts/gerar-sinais-sombra-1x.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { preverConfronto, partidasAntesDe } from './lib/poisson.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const LIMIAR_1X_PRODUCAO = 0.65;
const MINIMO_CASOS_COMPETICAO = 60;
// Janela móvel de 5 dias -- IDÊNTICA ao padrão do sync-odds.js (que usa
// Date.now() + dias*86400000, não dia civil). Usar dia civil aqui criaria
// risco de fuso horário entre os 2 scripts. Rodar sempre nessa ordem:
//   node scripts/sync-odds.js        (padrão já é 5 dias)
//   node scripts/gerar-sinais-sombra-1x.js
const JANELA_DIAS_A_FRENTE = 5;

// Congelados no teste final aprovado -- nunca retreinados aqui.
// NOTA: a=0.6022 e b=0.3145 são os valores arredondados a 4 casas que
// apareceram na tela do teste final -- esses 2 valores SÃO, oficialmente,
// a definição de platt_1x_v1 (não uma aproximação de algo "mais preciso").
// Se um dia recuperarmos os parâmetros com mais casas decimais, isso vira
// uma versão nova (platt_1x_v2), não uma correção desta.
const MODELO_VERSAO = 'platt_1x_v1';
const DATASET_HASH = 'b5eece395054deb68762540ca0417127773d92c5b83953e5edd4e31ab7102b1e';
const PARAMETRO_A = 0.6022;
const PARAMETRO_B = 0.3145;

function logit(p) {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
}
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}
function aplicarPlatt(probabilidadeBruta) {
  return sigmoid(PARAMETRO_A + PARAMETRO_B * logit(probabilidadeBruta));
}

async function buscarTudoPaginado(query) {
  const TAMANHO_PAGINA = 1000;
  let pagina = 0;
  let todos = [];
  while (true) {
    const { data, error } = await query.range(pagina * TAMANHO_PAGINA, pagina * TAMANHO_PAGINA + TAMANHO_PAGINA - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    todos = todos.concat(data);
    if (data.length < TAMANHO_PAGINA) break;
    pagina++;
  }
  return todos;
}

async function main() {
  const { data: competicoes } = await supabase.from('competicoes').select('id, nome').eq('ativa', true);

  let criados = 0;
  let jaExistiam = 0;
  let ignoradosPorFiltro = 0;
  let ignoradosPorHistoricoInsuficiente = 0; // preverConfronto() devolveu null pro jogo específico
  let ignoradosPorCompeticaoSemHistorico = 0; // competição inteira sem os 60 jogos mínimos
  let ignoradosPorBaselineInsuficiente = 0; // competição sem os 60 casos filtrados mínimos pro baseline
  let ignoradosPorSemOdd = 0; // Bet365 ainda não tem odd pra esse jogo -- tenta de novo depois
  let totalJogosConsiderados = 0;

  for (const comp of competicoes) {
    // Busca os próximos jogos primeiro -- assim, se a competição não tiver
    // histórico/baseline suficiente, sabemos exatamente quantos jogos
    // ficaram de fora por esse motivo (não só "pulamos a competição")
    const agora = new Date();
    const limiteFuturo = new Date(agora.getTime() + JANELA_DIAS_A_FRENTE * 86400000);
    const { data: proximosJogos, error: erroProximosJogos } = await supabase
      .from('partidas')
      .select('id, time_casa_id, time_fora_id, data_hora, status')
      .eq('competicao_id', comp.id)
      .eq('status', 'agendado')
      .gte('data_hora', agora.toISOString())
      .lte('data_hora', limiteFuturo.toISOString())
      .order('data_hora', { ascending: true });

    if (erroProximosJogos) {
      console.error(`${comp.nome}: erro ao buscar próximos jogos:`, erroProximosJogos.message);
      continue;
    }
    if (!proximosJogos || proximosJogos.length === 0) continue;

    totalJogosConsiderados += proximosJogos.length;

    const todasPartidas = await buscarTudoPaginado(
      supabase.from('partidas').select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
        .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
        .order('data_hora', { ascending: true })
    );

    if (todasPartidas.length < MINIMO_CASOS_COMPETICAO) {
      console.log(`${comp.nome}: histórico insuficiente ainda (${todasPartidas.length} jogos finalizados, mínimo ${MINIMO_CASOS_COMPETICAO}) -- ${proximosJogos.length} jogo(s) próximo(s) ficam sem sinal.`);
      ignoradosPorCompeticaoSemHistorico += proximosJogos.length;
      continue;
    }

    // Baseline dessa competição: walk-forward em cima do próprio
    // histórico, filtra p1X > 0.65, taxa real de acerto -- mesma
    // metodologia validada no teste final, agora usando TODO o histórico
    let acertosBaseline = 0, totalBaseline = 0;
    for (let i = 0; i < todasPartidas.length; i++) {
      const partida = todasPartidas[i];
      const anteriores = partidasAntesDe(todasPartidas, partida);
      const previsao = preverConfronto(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
      if (!previsao || previsao.p1X <= LIMIAR_1X_PRODUCAO) continue;
      totalBaseline++;
      if (partida.gols_casa >= partida.gols_fora) acertosBaseline++;
    }

    if (totalBaseline < MINIMO_CASOS_COMPETICAO) {
      console.log(`${comp.nome}: baseline insuficiente ainda (${totalBaseline} casos filtrados, mínimo ${MINIMO_CASOS_COMPETICAO}) -- ${proximosJogos.length} jogo(s) próximo(s) ficam sem sinal.`);
      ignoradosPorBaselineInsuficiente += proximosJogos.length;
      continue;
    }
    const taxaBaseline = acertosBaseline / totalBaseline;

    for (const jogo of proximosJogos) {
      const anteriores = partidasAntesDe(todasPartidas, jogo);
      const previsao = preverConfronto(anteriores, jogo.time_casa_id, jogo.time_fora_id, jogo.data_hora);
      if (!previsao) {
        ignoradosPorHistoricoInsuficiente++;
        continue;
      }

      if (previsao.p1X <= LIMIAR_1X_PRODUCAO) {
        ignoradosPorFiltro++;
        continue;
      }

      const probabilidadePlatt = aplicarPlatt(previsao.p1X);

      // Momento exato da decisão -- usado tanto pra limitar a busca de odd
      // (só odds capturadas ATÉ esse instante) quanto como criado_em,
      // garantindo matematicamente odd_no_sinal_em <= criado_em
      const momentoSinal = new Date().toISOString();

      // Odd mais recente da Bet365, capturada até o momento do sinal (nunca
      // depois). Erro de consulta é tratado explicitamente -- NUNCA vira
      // NULL silenciosamente, porque esse campo é imutável depois de
      // gravado (um erro transiente não pode virar "odd indisponível" pra
      // sempre).
      const { data: oddsRecentes, error: erroOdds } = await supabase
        .from('odds_historico')
        .select('odd_dupla_1x, capturado_em')
        .eq('partida_id', jogo.id)
        .eq('casa_apostas', 'Bet365')
        .not('odd_dupla_1x', 'is', null)
        .lte('capturado_em', momentoSinal)
        .order('capturado_em', { ascending: false })
        .limit(1);

      if (erroOdds) {
        console.error(`  Erro buscando odd da partida ${jogo.id}:`, erroOdds.message, '-- pulando esse jogo por agora.');
        continue;
      }

      const oddNoSinal = oddsRecentes?.[0]?.odd_dupla_1x ?? null;
      const oddNoSinalEm = oddsRecentes?.[0]?.capturado_em ?? null;

      // Sem odd Bet365 ainda -- NÃO grava com odd_no_sinal=null (esse
      // campo é imutável, ficaria travado sem odd pra sempre). Pula esse
      // jogo por agora; ele tenta de novo na próxima execução (upsert com
      // ignoreDuplicates permite isso, já que nada foi inserido ainda).
      if (oddNoSinal === null) {
        ignoradosPorSemOdd++;
        continue;
      }

      const { error, data: inserido } = await supabase
        .from('sinais_sombra_1x')
        .upsert(
          {
            partida_id: jogo.id,
            competicao_id: comp.id,
            modelo_versao: MODELO_VERSAO,
            dataset_hash: DATASET_HASH,
            parametro_a: PARAMETRO_A,
            parametro_b: PARAMETRO_B,
            limiar: LIMIAR_1X_PRODUCAO,
            probabilidade_bruta: previsao.p1X,
            probabilidade_platt: probabilidadePlatt,
            probabilidade_baseline: taxaBaseline,
            odd_no_sinal: oddNoSinal,
            odd_no_sinal_em: oddNoSinalEm,
            criado_em: momentoSinal,
          },
          { onConflict: 'partida_id,modelo_versao', ignoreDuplicates: true }
        )
        .select();

      if (error) {
        console.error(`  Erro ao gravar sinal sombra (partida ${jogo.id}):`, error.message);
      } else if (inserido && inserido.length > 0) {
        criados++;
      } else {
        jaExistiam++; // conflito ignorado -- já existia, não foi sobrescrito
      }
    }
  }

  const somaTotal = criados + jaExistiam + ignoradosPorFiltro + ignoradosPorHistoricoInsuficiente + ignoradosPorCompeticaoSemHistorico + ignoradosPorBaselineInsuficiente + ignoradosPorSemOdd;

  console.log('\n=== Geração de sinais sombra (Dupla 1X) concluída ===');
  console.log(`Jogos considerados (dentro da janela de ${JANELA_DIAS_A_FRENTE} dias): ${totalJogosConsiderados}`);
  console.log(`Sinais novos criados: ${criados}`);
  console.log(`Já existiam (ignorados, não sobrescritos): ${jaExistiam}`);
  console.log(`Não passaram no filtro p1X > ${LIMIAR_1X_PRODUCAO}: ${ignoradosPorFiltro}`);
  console.log(`Sem histórico suficiente pro Poisson calcular (jogo específico): ${ignoradosPorHistoricoInsuficiente}`);
  console.log(`Competição sem os ${MINIMO_CASOS_COMPETICAO} jogos finalizados mínimos: ${ignoradosPorCompeticaoSemHistorico}`);
  console.log(`Competição sem os ${MINIMO_CASOS_COMPETICAO} casos filtrados mínimos pro baseline: ${ignoradosPorBaselineInsuficiente}`);
  console.log(`Sem odd Bet365 no momento do sinal (tenta de novo depois): ${ignoradosPorSemOdd}`);
  console.log(`\nConferência: soma dos motivos = ${somaTotal} ${somaTotal === totalJogosConsiderados ? '✅ bate com o total considerado' : `⚠️  NÃO bate com o total considerado (${totalJogosConsiderados}) -- investigar`}`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
