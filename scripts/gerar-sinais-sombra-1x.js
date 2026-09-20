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
// Só gera sinal pra jogos de HOJE -- alinhado com o sync-odds.js, que só
// coleta odds pra jogos de hoje (--apenas-hoje). Se a janela aqui for mais
// larga que a da coleta de odds, o sinal fica com odd_no_sinal = NULL pra
// sempre (o campo é imutável, nunca é atualizado depois de criado).

// Congelados no teste final aprovado -- nunca retreinados aqui
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
  let ignoradosPorBaselineInsuficiente = 0;

  for (const comp of competicoes) {
    const todasPartidas = await buscarTudoPaginado(
      supabase.from('partidas').select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
        .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
        .order('data_hora', { ascending: true })
    );

    if (todasPartidas.length < MINIMO_CASOS_COMPETICAO) continue;

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
      console.log(`${comp.nome}: baseline insuficiente ainda (${totalBaseline} casos filtrados, mínimo ${MINIMO_CASOS_COMPETICAO}) -- pulando.`);
      continue;
    }
    const taxaBaseline = acertosBaseline / totalBaseline;

    // Próximos jogos dessa competição -- só HOJE, batendo exatamente com a
    // janela que o sync-odds.js usa pra coletar odds. Isso maximiza a
    // chance de já existir uma odd real no momento da criação do sinal.
    const agora = new Date();
    const fimDeHoje = new Date(agora);
    fimDeHoje.setHours(23, 59, 59, 999);
    const { data: proximosJogos } = await supabase
      .from('partidas')
      .select('id, time_casa_id, time_fora_id, data_hora, status')
      .eq('competicao_id', comp.id)
      .neq('status', 'finalizado')
      .gte('data_hora', agora.toISOString())
      .lte('data_hora', fimDeHoje.toISOString())
      .order('data_hora', { ascending: true });

    if (!proximosJogos || proximosJogos.length === 0) continue;

    for (const jogo of proximosJogos) {
      const anteriores = partidasAntesDe(todasPartidas, jogo);
      const previsao = preverConfronto(anteriores, jogo.time_casa_id, jogo.time_fora_id, jogo.data_hora);
      if (!previsao) continue;

      if (previsao.p1X <= LIMIAR_1X_PRODUCAO) {
        ignoradosPorFiltro++;
        continue;
      }

      const probabilidadePlatt = aplicarPlatt(previsao.p1X);

      // Odd mais recente da Bet365 disponível AGORA (jogo ainda não
      // aconteceu, então "mais recente" = a odd válida no instante da
      // criação do sinal)
      const { data: oddsRecentes } = await supabase
        .from('odds_historico')
        .select('odd_dupla_1x, capturado_em')
        .eq('partida_id', jogo.id)
        .eq('casa_apostas', 'Bet365')
        .not('odd_dupla_1x', 'is', null)
        .order('capturado_em', { ascending: false })
        .limit(1);

      const oddNoSinal = oddsRecentes?.[0]?.odd_dupla_1x ?? null;
      const oddNoSinalEm = oddsRecentes?.[0]?.capturado_em ?? null;

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

  console.log('\n=== Geração de sinais sombra (Dupla 1X) concluída ===');
  console.log(`Sinais novos criados: ${criados}`);
  console.log(`Já existiam (ignorados, não sobrescritos): ${jaExistiam}`);
  console.log(`Não passaram no filtro p1X > ${LIMIAR_1X_PRODUCAO}: ${ignoradosPorFiltro}`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
