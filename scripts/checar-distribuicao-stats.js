/**
 * checar-distribuicao-stats.js
 *
 * Antes de tentar análise walk-forward com posse de bola/finalizações,
 * precisamos saber: os jogos com esse dado estão bem distribuídos entre os
 * times, ou concentrados em só alguns? Se um time só tem 2-3 jogos com stats,
 * não dá pra calcular uma média histórica minimamente confiável pra ele.
 *
 * Uso:
 *   node scripts/checar-distribuicao-stats.js --competicao=71
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltam variáveis de ambiente: SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { data: partidas } = await supabase
    .from('partidas')
    .select('id, time_casa_id, time_fora_id')
    .eq('competicao_id', comp.id)
    .eq('status', 'finalizado');

  const idsPartidas = partidas.map((p) => p.id);

  const { data: statsExistentes } = await supabase
    .from('estatisticas_partida')
    .select('partida_id')
    .in('partida_id', idsPartidas)
    .not('finalizacoes_no_gol', 'is', null);

  const idsComStats = new Set(statsExistentes.map((s) => s.partida_id));
  const partidasComStats = partidas.filter((p) => idsComStats.has(p.id));

  const contagemPorTime = {};
  for (const p of partidasComStats) {
    contagemPorTime[p.time_casa_id] = (contagemPorTime[p.time_casa_id] || 0) + 1;
    contagemPorTime[p.time_fora_id] = (contagemPorTime[p.time_fora_id] || 0) + 1;
  }

  const { data: times } = await supabase.from('times').select('id, nome');
  const nomeDoTime = Object.fromEntries(times.map((t) => [t.id, t.nome]));

  const listaOrdenada = Object.entries(contagemPorTime)
    .map(([timeId, count]) => ({ nome: nomeDoTime[timeId] || `Time ${timeId}`, count }))
    .sort((a, b) => b.count - a.count);

  console.log(`=== Distribuição de jogos com stats por time: ${comp.nome} ===\n`);
  console.log(`Total de times com pelo menos 1 jogo com stats: ${listaOrdenada.length}\n`);

  for (const item of listaOrdenada) {
    console.log(`  ${item.nome}: ${item.count} jogos com stats`);
  }

  const valores = listaOrdenada.map((i) => i.count);
  const minimo = Math.min(...valores);
  const maximo = Math.max(...valores);
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;

  console.log(`\nMínimo: ${minimo} | Máximo: ${maximo} | Média: ${media.toFixed(1)}`);

  const MINIMO_RAZOAVEL = 8;
  const timesComPoucoDado = listaOrdenada.filter((i) => i.count < MINIMO_RAZOAVEL).length;
  console.log(`\nTimes com menos de ${MINIMO_RAZOAVEL} jogos com stats: ${timesComPoucoDado} de ${listaOrdenada.length}`);
  console.log(timesComPoucoDado > listaOrdenada.length * 0.3
    ? '⚠️  Mais de 30% dos times têm pouco dado -- análise walk-forward ainda arriscada, recomendo esperar mais sincronização.'
    : '✅ Distribuição razoável -- dá pra tentar análise walk-forward com cuidado.');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
