/**
 * votacao-4-quesitos.js
 *
 * Compara os 4 quesitos (posse de bola, finalizações, finalizações no gol,
 * escanteios) entre mandante e visitante -- quem tem o valor médio maior
 * "vence" aquele quesito. Depois classifica o confronto:
 *
 *  - Um time vence os 4 quesitos → favorito (independente de mando de campo)
 *  - Um time vence 3 de 4 quesitos → continua favorito
 *  - Empate 2x2 → tendência pro mandante
 *
 * Testa se essas categorias realmente se traduzem em resultado real --
 * walk-forward, sem olhar o futuro.
 *
 * Uso:
 *   node scripts/votacao-4-quesitos.js --competicao=71
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
const JANELA = 6;
const METRICAS = ['posse_bola', 'finalizacoes', 'finalizacoes_no_gol', 'escanteios'];

function mediaTime(jogosAnteriores, timeId, campo, statsPorPartidaTime) {
  const jogosDoTime = jogosAnteriores
    .filter((p) => p.time_casa_id === timeId || p.time_fora_id === timeId)
    .slice(-JANELA);
  if (jogosDoTime.length < 3) return null;
  const soma = jogosDoTime.reduce((s, p) => {
    const st = statsPorPartidaTime[`${p.id}_${timeId}`];
    return s + (st?.[campo] ?? 0);
  }, 0);
  return soma / jogosDoTime.length;
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { data: todasPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  const idsPartidas = todasPartidas.map((p) => p.id);
  const { data: stats } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, time_id, posse_bola, finalizacoes, finalizacoes_no_gol, escanteios')
    .in('partida_id', idsPartidas);

  const statsPorPartidaTime = {};
  for (const s of stats) statsPorPartidaTime[`${s.partida_id}_${s.time_id}`] = s;

  const partidasComStats = todasPartidas.filter((p) => {
    const sc = statsPorPartidaTime[`${p.id}_${p.time_casa_id}`];
    const sf = statsPorPartidaTime[`${p.id}_${p.time_fora_id}`];
    return sc && sf && sc.finalizacoes_no_gol != null && sf.finalizacoes_no_gol != null;
  });

  console.log(`${comp.nome} -- ${partidasComStats.length} partidas com stats completas.\n`);

  // Categorias: quantos quesitos o mandante venceu (0 a 4)
  const categorias = { 0: [], 1: [], 2: [], 3: [], 4: [] };

  for (let i = 0; i < partidasComStats.length; i++) {
    const partida = partidasComStats[i];
    const anteriores = partidasComStats.slice(0, i);

    let quesitosCasa = 0;
    let quesitosValidos = 0;

    for (const campo of METRICAS) {
      const mediaCasa = mediaTime(anteriores, partida.time_casa_id, campo, statsPorPartidaTime);
      const mediaFora = mediaTime(anteriores, partida.time_fora_id, campo, statsPorPartidaTime);
      if (mediaCasa === null || mediaFora === null) continue;

      quesitosValidos++;
      if (mediaCasa > mediaFora) quesitosCasa++;
    }

    if (quesitosValidos < 4) continue; // só considera jogos com os 4 quesitos calculáveis

    let resultado;
    if (partida.gols_casa > partida.gols_fora) resultado = 'casa';
    else if (partida.gols_casa === partida.gols_fora) resultado = 'empate';
    else resultado = 'fora';

    categorias[quesitosCasa].push(resultado);
  }

  console.log('=== Resultado por categoria (quantos dos 4 quesitos o MANDANTE venceu) ===\n');

  const rotulos = {
    4: 'Mandante venceu os 4 quesitos (favorito total)',
    3: 'Mandante venceu 3 de 4 quesitos (favorito)',
    2: 'Empate 2x2 nos quesitos (tendência pro mandante)',
    1: 'Visitante venceu 3 de 4 quesitos (visitante favorito)',
    0: 'Visitante venceu os 4 quesitos (visitante favorito total)',
  };

  for (const cat of [4, 3, 2, 1, 0]) {
    const casos = categorias[cat];
    if (casos.length === 0) {
      console.log(`${rotulos[cat]}: 0 jogos.\n`);
      continue;
    }
    const casa = casos.filter((r) => r === 'casa').length;
    const empate = casos.filter((r) => r === 'empate').length;
    const fora = casos.filter((r) => r === 'fora').length;
    const total = casos.length;

    console.log(`${rotulos[cat]}: ${total} jogos`);
    console.log(`  Casa venceu: ${casa} (${((casa / total) * 100).toFixed(1)}%)  |  Empate: ${empate} (${((empate / total) * 100).toFixed(1)}%)  |  Fora venceu: ${fora} (${((fora / total) * 100).toFixed(1)}%)`);
    if (total < 20) console.log('  ⚠️  Amostra pequena, resultado pouco confiável ainda.');
    console.log('');
  }

  console.log('=== Como interpretar ===');
  console.log('Se a lógica funciona, esperamos: categoria 4 e 3 (mandante favorito) com % de vitória da CASA');
  console.log('alto; categoria 1 e 0 (visitante favorito) com % de vitória de FORA alto; categoria 2 (empate');
  console.log('nos quesitos) com tendência pra casa, mas mais moderada que as categorias 3-4.');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
