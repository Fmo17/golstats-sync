/**
 * encontrar-valor.js
 *
 * Cruza os sinais do modelo com as odds reais coletadas. Calcula a odd
 * mínima necessária pra cada sinal ser lucrativo (1 / probabilidade do
 * modelo), compara com a melhor odd real disponível, e classifica em 3
 * grupos:
 *
 *   1. VALOR CONFIRMADO -- odd oferecida > odd mínima necessária
 *      (o único grupo recomendável pra apostar de verdade agora)
 *   2. ALTA CONFIANÇA SEM VALOR -- modelo calcula >70%, mas o mercado
 *      discorda (odd abaixo da mínima). NÃO é recomendado apostar nesses
 *      ainda -- são monitorados pra construir evidência: será que o modelo
 *      tem razão quando diverge do mercado, ou é o mercado que está certo?
 *      Só decidimos isso com dado acumulado ao longo do tempo.
 *   3. RESTO -- sinais de confiança mais baixa, sem valor.
 *
 * A classificação fica GRAVADA em cada sinal (colunas teve_valor,
 * odd_referencia, divergencia_valor), pra o verificar-sinais.js conseguir
 * separar a taxa de acerto real por grupo, futuramente.
 *
 * Uso:
 *   node scripts/encontrar-valor.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const LIMIAR_ALTA_CONFIANCA = 0.70;

const COLUNA_ODD_POR_MERCADO = {
  vitoria_casa: 'odd_casa',
  dupla_1x: 'odd_dupla_1x',
  dupla_x2: 'odd_dupla_x2',
  gols_1mais: 'odd_over_05',
  gols_2mais: 'odd_over_15',
  gols_3mais: 'odd_over_25',
};

const NOMES_MERCADO = {
  vitoria_casa: 'Vitória do mandante',
  gols_1mais: 'Gols 1+',
  gols_2mais: 'Gols 2+',
  gols_3mais: 'Gols 3+',
  dupla_x2: 'Dupla X2',
  dupla_1x: 'Dupla 1X',
};

async function main() {
  console.log('Buscando sinais e odds pra classificar valor...\n');

  const { data: sinais } = await supabase
    .from('sinais')
    .select('id, partida_id, tipo_mercado, probabilidade_modelo');

  if (!sinais || sinais.length === 0) {
    console.log('Nenhum sinal encontrado.');
    return;
  }

  const idsPartidas = [...new Set(sinais.map((s) => s.partida_id))];

  const { data: odds } = await supabase
    .from('odds_historico')
    .select('*')
    .in('partida_id', idsPartidas)
    .order('capturado_em', { ascending: false });

  if (!odds || odds.length === 0) {
    console.log('Nenhuma odd encontrada -- roda o sync-odds.js primeiro.');
    return;
  }

  const oddsRecentesPorPartidaCasa = {};
  for (const o of odds) {
    const chave = `${o.partida_id}_${o.casa_apostas}`;
    if (!oddsRecentesPorPartidaCasa[chave]) oddsRecentesPorPartidaCasa[chave] = o;
  }
  const oddsRecentes = Object.values(oddsRecentesPorPartidaCasa);

  const { data: partidas } = await supabase.from('partidas').select('id, data_hora, competicao_id, time_casa_id, time_fora_id').in('id', idsPartidas);
  const partidaPorId = Object.fromEntries((partidas || []).map((p) => [p.id, p]));
  const idsComp = [...new Set((partidas || []).map((p) => p.competicao_id))];
  const idsTimes = [...new Set((partidas || []).flatMap((p) => [p.time_casa_id, p.time_fora_id]))];
  const [{ data: comps }, { data: times }] = await Promise.all([
    supabase.from('competicoes').select('id, nome').in('id', idsComp),
    supabase.from('times').select('id, nome').in('id', idsTimes),
  ]);
  const compPorId = Object.fromEntries((comps || []).map((c) => [c.id, c.nome]));
  const timePorId = Object.fromEntries((times || []).map((t) => [t.id, t.nome]));

  const todosComOdd = [];
  let semOddDisponivel = 0;
  let atualizados = 0;

  for (const sinal of sinais) {
    const colunaOdd = COLUNA_ODD_POR_MERCADO[sinal.tipo_mercado];
    if (!colunaOdd) continue;

    const oddsDessaPartida = oddsRecentes.filter((o) => o.partida_id === sinal.partida_id && o[colunaOdd] !== null);
    if (oddsDessaPartida.length === 0) { semOddDisponivel++; continue; }

    const melhorOdd = oddsDessaPartida.reduce((melhor, atual) => (atual[colunaOdd] > melhor[colunaOdd] ? atual : melhor));
    const oddOferecida = melhorOdd[colunaOdd];
    const oddMinimaNecessaria = 1 / sinal.probabilidade_modelo;
    const divergencia = sinal.probabilidade_modelo - (1 / oddOferecida);
    const temValor = oddOferecida > oddMinimaNecessaria;

    const { error: erroUpdate } = await supabase
      .from('sinais')
      .update({ teve_valor: temValor, odd_referencia: oddOferecida, divergencia_valor: divergencia })
      .eq('id', sinal.id);
    if (!erroUpdate) atualizados++;

    todosComOdd.push({ sinal, partida: partidaPorId[sinal.partida_id], oddOferecida, casaApostas: melhorOdd.casa_apostas, oddMinimaNecessaria, divergencia, temValor });
  }

  // Ordena da divergência MAIS POSITIVA pra MAIS NEGATIVA -- mostra tudo, sem esconder nada
  todosComOdd.sort((a, b) => b.divergencia - a.divergencia);

  console.log(`Sinais atualizados com classificação: ${atualizados}`);
  console.log(`Sinais sem odd disponível ainda: ${semOddDisponivel}\n`);
  console.log(`=== Todos os ${todosComOdd.length} sinais com odd disponível, do maior valor ao menor ===\n`);

  for (const op of todosComOdd) {
    const p = op.partida;
    const nomeComp = compPorId[p.competicao_id] || '';
    const nomeCasa = timePorId[p.time_casa_id] || '';
    const nomeFora = timePorId[p.time_fora_id] || '';
    const data = new Date(p.data_hora).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const sinalDivergencia = op.divergencia >= 0 ? '+' : '';

    console.log(`${op.temValor ? '✅' : '  '} ${nomeComp}: ${nomeCasa} x ${nomeFora} (${data})`);
    console.log(`   Mercado: ${NOMES_MERCADO[op.sinal.tipo_mercado]} -- modelo calcula ${(op.sinal.probabilidade_modelo * 100).toFixed(1)}%`);
    console.log(`   Odd mínima necessária: ${op.oddMinimaNecessaria.toFixed(2)}  |  Odd oferecida (${op.casaApostas}): ${op.oddOferecida.toFixed(2)}  |  Divergência: ${sinalDivergencia}${(op.divergencia * 100).toFixed(1)} p.p.\n`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
