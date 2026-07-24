/**
 * correlacao-finalizacoes.js
 *
 * Testa 3 hipóteses, usando SÓ jogos com stats disponíveis (walk-forward,
 * histórico de cada time também restrito a jogos com stats):
 *
 *  1. Finalizações (total) recentes do time prevêem os gols reais dele no
 *     próximo jogo?
 *  2. Finalizações NO GOL recentes prevêem melhor que finalizações totais?
 *     (teoricamente deveria, já que é mais "filtrado" -- só chutes que
 *     tinham chance real de virar gol)
 *  3. Posse de bola tem correlação com o RESULTADO (vitória/derrota)? Mito
 *     comum de que "mais posse = mais chance de vencer" -- testamos com
 *     dado real.
 *
 * Uso:
 *   node scripts/correlacao-finalizacoes.js --competicao=71
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
const JANELA = 6; // janela menor, já que temos ~35 jogos com stats por time

function correlacaoPearson(X, Y) {
  const n = X.length;
  const mediaX = X.reduce((a, b) => a + b, 0) / n;
  const mediaY = Y.reduce((a, b) => a + b, 0) / n;
  let sp = 0, sqx = 0, sqy = 0;
  for (let i = 0; i < n; i++) {
    const dx = X[i] - mediaX, dy = Y[i] - mediaY;
    sp += dx * dy; sqx += dx * dx; sqy += dy * dy;
  }
  const denom = Math.sqrt(sqx * sqy);
  return denom === 0 ? 0 : sp / denom;
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  console.log(`Carregando partidas com stats de: ${comp.nome}...`);

  const { data: todasPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  const idsPartidas = todasPartidas.map((p) => p.id);
  const { data: stats } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, time_id, posse_bola, finalizacoes, finalizacoes_no_gol')
    .in('partida_id', idsPartidas);

  // Organiza stats por partida + time, pra acesso rápido
  const statsPorPartidaTime = {};
  for (const s of stats) {
    statsPorPartidaTime[`${s.partida_id}_${s.time_id}`] = s;
  }

  // Só as partidas onde AMBOS os times têm stats registradas
  const partidasComStats = todasPartidas.filter((p) => {
    const statsCasa = statsPorPartidaTime[`${p.id}_${p.time_casa_id}`];
    const statsFora = statsPorPartidaTime[`${p.id}_${p.time_fora_id}`];
    return statsCasa && statsFora && statsCasa.finalizacoes_no_gol != null && statsFora.finalizacoes_no_gol != null;
  });

  console.log(`Partidas com stats completas (os 2 times): ${partidasComStats.length}\n`);

  const X_finalizacoes = [], X_finalizacoesNoGol = [], Y_golsReais = [];
  const X_posse = [], Y_venceu = [];

  for (let i = 0; i < partidasComStats.length; i++) {
    const partida = partidasComStats[i];
    const anteriores = partidasComStats.slice(0, i); // só partidas anteriores COM stats

    // Histórico do time da casa (últimos jogos com stats, jogando em casa)
    const jogosAnterioresCasa = anteriores.filter((p) => p.time_casa_id === partida.time_casa_id).slice(-JANELA);
    if (jogosAnterioresCasa.length < 3) continue;

    const mediaFinalizacoes = jogosAnterioresCasa.reduce((s, p) => {
      const st = statsPorPartidaTime[`${p.id}_${partida.time_casa_id}`];
      return s + (st?.finalizacoes ?? 0);
    }, 0) / jogosAnterioresCasa.length;

    const mediaFinalizacoesNoGol = jogosAnterioresCasa.reduce((s, p) => {
      const st = statsPorPartidaTime[`${p.id}_${partida.time_casa_id}`];
      return s + (st?.finalizacoes_no_gol ?? 0);
    }, 0) / jogosAnterioresCasa.length;

    const mediaPosse = jogosAnterioresCasa.reduce((s, p) => {
      const st = statsPorPartidaTime[`${p.id}_${partida.time_casa_id}`];
      return s + (st?.posse_bola ?? 0);
    }, 0) / jogosAnterioresCasa.length;

    X_finalizacoes.push(mediaFinalizacoes);
    X_finalizacoesNoGol.push(mediaFinalizacoesNoGol);
    Y_golsReais.push(partida.gols_casa);

    X_posse.push(mediaPosse);
    Y_venceu.push(partida.gols_casa > partida.gols_fora ? 1 : 0);
  }

  console.log(`Partidas analisadas (com histórico suficiente): ${X_finalizacoes.length}\n`);

  const r_finalizacoes = correlacaoPearson(X_finalizacoes, Y_golsReais);
  const r_finalizacoesNoGol = correlacaoPearson(X_finalizacoesNoGol, Y_golsReais);
  const r_posse = correlacaoPearson(X_posse, Y_venceu);
  const r_entreSi = correlacaoPearson(X_finalizacoes, X_finalizacoesNoGol);

  console.log('=== Resultado ===\n');
  console.log(`1. Finalizações totais (média histórica) × gols reais: r = ${r_finalizacoes.toFixed(3)}`);
  console.log(`2. Finalizações NO GOL (média histórica) × gols reais: r = ${r_finalizacoesNoGol.toFixed(3)}`);
  console.log(`   ${Math.abs(r_finalizacoesNoGol) > Math.abs(r_finalizacoes) ? '✅ Finalizações no gol prevêem MELHOR' : '❌ Finalizações totais prevêem igual ou melhor'}\n`);
  console.log(`   Correlação entre as duas métricas (finalizações × finalizações no gol): r = ${r_entreSi.toFixed(3)}`);
  console.log(`   (Se esse número for alto, explica por que as correlações com gols saíram parecidas -- as duas`);
  console.log(`   métricas carregam informação redundante, um time que finaliza mais também acerta mais no gol.)\n`);
  console.log(`3. Posse de bola (média histórica) × vitória: r = ${r_posse.toFixed(3)}`);
  console.log(`   (Referência: correlações abaixo de 0.1 = praticamente nenhuma relação; 0.1-0.3 = fraca; 0.3-0.5 = moderada)`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
