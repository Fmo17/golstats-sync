/**
 * visualizar-valores-reais.js
 *
 * Mostra, PARTIDA POR PARTIDA, os valores REAIS (médias brutas, não ranking)
 * de posse de bola, finalizações, finalizações no gol e escanteios dos 2
 * times, no formato: "Palmeiras - 55% de média | Santos - 51% de média".
 *
 * Uso:
 *   node scripts/visualizar-valores-reais.js --competicao=71 --jogos=20
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

function mediaTime(jogosAnteriores, timeId, campo, statsPorPartidaTime) {
  const jogosDoTime = jogosAnteriores
    .filter((p) => p.time_casa_id === timeId || p.time_fora_id === timeId)
    .slice(-JANELA);
  if (jogosDoTime.length < 3) return null;

  const soma = jogosDoTime.reduce((s, p) => {
    const st = statsPorPartidaTime[`${p.id}_${timeId}`];
    return s + (st?.[campo] ?? 0);
  }, 0);

  return { media: soma / jogosDoTime.length, amostra: jogosDoTime.length };
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const jogosArg = args.find((a) => a.startsWith('--jogos='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;
  const numJogosMostrar = jogosArg ? parseInt(jogosArg.split('=')[1], 10) : 20;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { data: todasPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora, times_casa:times!partidas_time_casa_id_fkey(nome), times_fora:times!partidas_time_fora_id_fkey(nome)')
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

  let mostradas = 0;

  for (let i = 0; i < partidasComStats.length && mostradas < numJogosMostrar; i++) {
    const partida = partidasComStats[i];
    const anteriores = partidasComStats.slice(0, i);

    const posseCasa = mediaTime(anteriores, partida.time_casa_id, 'posse_bola', statsPorPartidaTime);
    const posseFora = mediaTime(anteriores, partida.time_fora_id, 'posse_bola', statsPorPartidaTime);
    if (!posseCasa || !posseFora) continue;

    const finalizacoesCasa = mediaTime(anteriores, partida.time_casa_id, 'finalizacoes', statsPorPartidaTime);
    const finalizacoesFora = mediaTime(anteriores, partida.time_fora_id, 'finalizacoes', statsPorPartidaTime);

    const finalizacoesNoGolCasa = mediaTime(anteriores, partida.time_casa_id, 'finalizacoes_no_gol', statsPorPartidaTime);
    const finalizacoesNoGolFora = mediaTime(anteriores, partida.time_fora_id, 'finalizacoes_no_gol', statsPorPartidaTime);

    const escanteiosCasa = mediaTime(anteriores, partida.time_casa_id, 'escanteios', statsPorPartidaTime);
    const escanteiosFora = mediaTime(anteriores, partida.time_fora_id, 'escanteios', statsPorPartidaTime);

    mostradas++;

    const nomeCasa = partida.times_casa?.nome || `Time ${partida.time_casa_id}`;
    const nomeFora = partida.times_fora?.nome || `Time ${partida.time_fora_id}`;

    let resultadoReal;
    if (partida.gols_casa > partida.gols_fora) resultadoReal = 'CASA venceu';
    else if (partida.gols_casa === partida.gols_fora) resultadoReal = 'EMPATE';
    else resultadoReal = 'FORA venceu';

    console.log(`--- Jogo ${mostradas}: ${nomeCasa} x ${nomeFora} (${new Date(partida.data_hora).toLocaleDateString('pt-BR')}) ---`);
    console.log(`  Posse de bola:         ${nomeCasa} - ${posseCasa.media.toFixed(0)}% de média   |   ${nomeFora} - ${posseFora.media.toFixed(0)}% de média`);
    console.log(`  Finalizações:          ${nomeCasa} - ${finalizacoesCasa?.media.toFixed(1) ?? 'N/D'} de média   |   ${nomeFora} - ${finalizacoesFora?.media.toFixed(1) ?? 'N/D'} de média`);
    console.log(`  Finalizações no gol:   ${nomeCasa} - ${finalizacoesNoGolCasa?.media.toFixed(1) ?? 'N/D'} de média   |   ${nomeFora} - ${finalizacoesNoGolFora?.media.toFixed(1) ?? 'N/D'} de média`);
    console.log(`  Escanteios:            ${nomeCasa} - ${escanteiosCasa?.media.toFixed(1) ?? 'N/D'} de média   |   ${nomeFora} - ${escanteiosFora?.media.toFixed(1) ?? 'N/D'} de média`);
    console.log(`  Resultado real: ${resultadoReal} (${partida.gols_casa} x ${partida.gols_fora})\n`);
  }

  console.log(`\n(Mostrados ${mostradas} jogos. Pra ver mais, roda com --jogos=40 por exemplo.)`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
