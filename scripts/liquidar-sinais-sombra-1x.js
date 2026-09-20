/**
 * scripts/liquidar-sinais-sombra-1x.js
 *
 * Fecha os sinais sombra cuja partida já terminou -- calcula resultado
 * (green/red), lucro com stake fixa de 1 unidade (usando a odd que estava
 * disponível no momento do sinal), e busca a última odd Bet365 capturada
 * ESTRITAMENTE ANTES do início da partida (nunca "a mais recente", pra não
 * pegar captura de depois do jogo em casos de atraso/remarcação).
 *
 * Toda consulta trata erro explicitamente -- um erro de rede/Supabase NUNCA
 * pode ser interpretado como "sem odd" ou fazer o sinal ser liquidado com
 * dado incompleto.
 *
 * Uso:
 *   node scripts/liquidar-sinais-sombra-1x.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  const { data: pendentes, error: erroPendentes } = await supabase
    .from('sinais_sombra_1x')
    .select('id, partida_id, odd_no_sinal')
    .eq('status', 'pendente');

  if (erroPendentes) {
    console.error('Erro ao buscar sinais pendentes:', erroPendentes.message);
    process.exit(1);
  }
  if (!pendentes || pendentes.length === 0) {
    console.log('Nenhum sinal sombra pendente.');
    return;
  }

  const idsPartidas = [...new Set(pendentes.map((s) => s.partida_id))];
  const { data: partidas, error: erroPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, status, gols_casa, gols_fora')
    .in('id', idsPartidas);

  if (erroPartidas) {
    console.error('Erro ao buscar partidas:', erroPartidas.message);
    process.exit(1);
  }
  const partidaPorId = Object.fromEntries((partidas || []).map((p) => [p.id, p]));

  let liquidados = 0;
  let aindaNaoTerminou = 0;
  let semGols = 0;
  let canceladas = 0;
  let puladosPorErro = 0;

  for (const sinal of pendentes) {
    const partida = partidaPorId[sinal.partida_id];
    if (!partida) continue;

    // Partida cancelada -- não é "ainda não terminou" nem "green/red",
    // é um caso à parte (marca status='cancelado', sem resultado nem lucro)
    if (partida.status === 'cancelado') {
      const { error: erroCancelamento } = await supabase
        .from('sinais_sombra_1x')
        .update({ status: 'cancelado' })
        .eq('id', sinal.id);
      if (erroCancelamento) {
        console.error(`  Erro ao marcar sinal como cancelado (partida ${sinal.partida_id}):`, erroCancelamento.message);
        puladosPorErro++;
      } else {
        canceladas++;
      }
      continue;
    }

    if (partida.status !== 'finalizado') {
      aindaNaoTerminou++;
      continue;
    }
    if (partida.gols_casa === null || partida.gols_fora === null) {
      semGols++;
      continue;
    }

    const resultado = partida.gols_casa >= partida.gols_fora; // 1X: casa vence ou empata

    // Lucro com stake fixa de 1 unidade, usando a odd que estava disponível
    // no momento em que o sinal foi criado (odd_no_sinal -- imutável)
    let lucroFlat = null;
    if (sinal.odd_no_sinal !== null) {
      lucroFlat = resultado ? sinal.odd_no_sinal - 1 : -1;
    }

    // Última odd Bet365 ESTRITAMENTE ANTES do início da partida -- nunca
    // "a mais recente" (evita pegar captura de depois do jogo em casos de
    // atraso, remarcação, ou status desatualizado). Erro de consulta NUNCA
    // vira "sem odd" -- pula esse sinal pra tentar de novo na próxima
    // execução, em vez de liquidar com dado incompleto.
    const { data: ultimasOdds, error: erroUltimaOdd } = await supabase
      .from('odds_historico')
      .select('odd_dupla_1x, capturado_em')
      .eq('partida_id', sinal.partida_id)
      .eq('casa_apostas', 'Bet365')
      .not('odd_dupla_1x', 'is', null)
      .lt('capturado_em', partida.data_hora)
      .order('capturado_em', { ascending: false })
      .limit(1);

    if (erroUltimaOdd) {
      console.error(`  Erro buscando última odd (partida ${sinal.partida_id}):`, erroUltimaOdd.message, '-- pulando, tenta de novo depois.');
      puladosPorErro++;
      continue;
    }

    const ultimaOdd = ultimasOdds?.[0]?.odd_dupla_1x ?? null;
    const ultimaOddEm = ultimasOdds?.[0]?.capturado_em ?? null;
    const minutosAntes = ultimaOddEm
      ? (new Date(partida.data_hora) - new Date(ultimaOddEm)) / 60000
      : null;

    const { error } = await supabase
      .from('sinais_sombra_1x')
      .update({
        resultado,
        lucro_flat: lucroFlat,
        ultima_odd_pre_jogo: ultimaOdd,
        ultima_odd_pre_jogo_em: ultimaOddEm,
        minutos_antes_inicio_ultima_odd: minutosAntes,
        status: 'finalizado',
      })
      .eq('id', sinal.id);

    if (error) {
      console.error(`  Erro ao liquidar sinal sombra (partida ${sinal.partida_id}):`, error.message);
      puladosPorErro++;
    } else {
      liquidados++;
    }
  }

  console.log('\n=== Liquidação de sinais sombra (Dupla 1X) concluída ===');
  console.log(`Liquidados agora: ${liquidados}`);
  console.log(`Ainda não terminaram: ${aindaNaoTerminou}`);
  if (canceladas > 0) console.log(`Marcados como cancelados: ${canceladas}`);
  if (semGols > 0) console.log(`Finalizados mas sem placar registrado ainda: ${semGols}`);
  if (puladosPorErro > 0) console.log(`⚠️  Pulados por erro de consulta (tentar de novo depois): ${puladosPorErro}`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
