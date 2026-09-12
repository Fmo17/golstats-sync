/**
 * ver-sinais-gerados.js
 *
 * Mostra, em texto legível, uma amostra dos sinais que já foram gerados --
 * nome dos times, data do jogo, mercado, e probabilidade calculada.
 *
 * Uso:
 *   node scripts/ver-sinais-gerados.js --quantidade=20
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const NOMES_MERCADO = {
  vitoria_casa: 'Vitória do mandante',
  gols_1mais: 'Gols 1+',
  gols_2mais: 'Gols 2+',
  gols_3mais: 'Gols 3+',
  dupla_x2: 'Dupla hipótese X2 (empate ou fora)',
  dupla_1x: 'Dupla hipótese 1X (casa ou empate)',
};

async function main() {
  const args = process.argv.slice(2);
  const qtdArg = args.find((a) => a.startsWith('--quantidade='));
  const quantidade = qtdArg ? parseInt(qtdArg.split('=')[1], 10) : 20;

  const { data: sinais, error } = await supabase
    .from('sinais')
    .select('id, partida_id, tipo_mercado, probabilidade_modelo, nivel_confianca');

  if (error) { console.error(error); return; }
  if (!sinais || sinais.length === 0) { console.log('Nenhum sinal encontrado.'); return; }

  const idsPartidas = [...new Set(sinais.map((s) => s.partida_id))];
  const { data: partidas } = await supabase
    .from('partidas')
    .select('id, data_hora, competicao_id, time_casa_id, time_fora_id')
    .in('id', idsPartidas);

  const partidaPorId = Object.fromEntries((partidas || []).map((p) => [p.id, p]));

  // Confirma a distribuição real de datas dos jogos com sinal, pra você ver
  // se setembro realmente tem pouco ou nenhum jogo agendado ainda.
  const datasOrdenadas = (partidas || []).map((p) => new Date(p.data_hora)).sort((a, b) => a - b);
  if (datasOrdenadas.length > 0) {
    console.log(`Intervalo de datas dos jogos com sinal: ${datasOrdenadas[0].toLocaleDateString('pt-BR')} até ${datasOrdenadas[datasOrdenadas.length - 1].toLocaleDateString('pt-BR')}`);
    const hoje = new Date();
    const proximos30Dias = datasOrdenadas.filter((d) => d >= hoje && d <= new Date(hoje.getTime() + 30 * 86400000));
    console.log(`Jogos com sinal nos próximos 30 dias: ${proximos30Dias.length} de ${datasOrdenadas.length}\n`);
  }

  // Ordena os SINAIS pela data do jogo mais próxima primeiro (não pela ordem
  // de inserção no banco).
  const sinaisComData = sinais
    .map((s) => ({ ...s, dataJogo: partidaPorId[s.partida_id]?.data_hora }))
    .filter((s) => s.dataJogo)
    .sort((a, b) => new Date(a.dataJogo) - new Date(b.dataJogo))
    .slice(0, quantidade);

  const idsCompeticoes = [...new Set((partidas || []).map((p) => p.competicao_id))];
  const { data: competicoes } = await supabase.from('competicoes').select('id, nome').in('id', idsCompeticoes);
  const compPorId = Object.fromEntries((competicoes || []).map((c) => [c.id, c.nome]));

  const idsTimes = [...new Set((partidas || []).flatMap((p) => [p.time_casa_id, p.time_fora_id]))];
  const { data: times } = await supabase.from('times').select('id, nome').in('id', idsTimes);
  const timePorId = Object.fromEntries((times || []).map((t) => [t.id, t.nome]));

  console.log(`Mostrando os ${sinaisComData.length} jogos MAIS PRÓXIMOS com sinal:\n`);

  for (const sinal of sinaisComData) {
    const partida = partidaPorId[sinal.partida_id];
    if (!partida) continue;

    const nomeCasa = timePorId[partida.time_casa_id] || `Time ${partida.time_casa_id}`;
    const nomeFora = timePorId[partida.time_fora_id] || `Time ${partida.time_fora_id}`;
    const nomeComp = compPorId[partida.competicao_id] || 'Competição desconhecida';
    const data = new Date(partida.data_hora).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

    console.log(`--- ${nomeComp} ---`);
    console.log(`  ${nomeCasa} x ${nomeFora}  (${data})`);
    console.log(`  Mercado: ${NOMES_MERCADO[sinal.tipo_mercado] || sinal.tipo_mercado}`);
    console.log(`  Probabilidade (histórica calibrada): ${(sinal.probabilidade_modelo * 100).toFixed(1)}%\n`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
