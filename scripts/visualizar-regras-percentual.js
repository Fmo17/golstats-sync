/**
 * visualizar-regras-percentual.js
 *
 * Mostra, PARTIDA POR PARTIDA, o raciocínio completo da regra percentual:
 * médias, % de diferença, faixa prevista, gols reais, e se bateu ou não.
 * Serve pra conferir manualmente se a lógica está calculando certo antes de
 * confiar no resultado agregado.
 *
 * Uso:
 *   node scripts/visualizar-regras-percentual.js --competicao=71 --jogos=30
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
const JANELA = 10;

function classificarPrevisao(diffPercentual) {
  if (diffPercentual > 30) return '3+';
  if (diffPercentual > 10) return '2';
  if (diffPercentual >= -10) return '1';
  if (diffPercentual >= -50) return 'nula';
  return '0';
}

function avaliarAcerto(golsTotais, previsao) {
  if (previsao === '3+') return golsTotais >= 3;
  if (previsao === '2') return golsTotais >= 2;
  if (previsao === '1') return golsTotais >= 1;
  if (previsao === '0') return golsTotais === 0;
  return null; // nula
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const jogosArg = args.find((a) => a.startsWith('--jogos='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;
  const numJogosMostrar = jogosArg ? parseInt(jogosArg.split('=')[1], 10) : 30;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora, times_casa:times!partidas_time_casa_id_fkey(nome), times_fora:times!partidas_time_fora_id_fkey(nome)')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  if (error) throw error;

  console.log(`${comp.nome} -- ${todasPartidas.length} partidas no banco. Janela de ${JANELA} jogos.\n`);

  let mostradas = 0;

  for (let i = 0; i < todasPartidas.length && mostradas < numJogosMostrar; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    const jogosMandante = anteriores.filter((p) => p.time_casa_id === partida.time_casa_id).slice(-JANELA);
    if (jogosMandante.length < 3) continue;
    const mediaMandante = jogosMandante.reduce((s, p) => s + p.gols_casa, 0) / jogosMandante.length;

    const jogosVisitante = anteriores.filter((p) => p.time_fora_id === partida.time_fora_id).slice(-JANELA);
    if (jogosVisitante.length < 3) continue;
    const mediaVisitante = jogosVisitante.reduce((s, p) => s + p.gols_fora, 0) / jogosVisitante.length;

    if (anteriores.length < 10) continue;
    const mediaLigaTotal = anteriores.reduce((s, p) => s + p.gols_casa + p.gols_fora, 0) / anteriores.length;
    const mediaLiga = mediaLigaTotal / 2;
    const mediaConfronto = (mediaMandante + mediaVisitante) / 2;
    const diffPercentual = ((mediaConfronto - mediaLiga) / mediaLiga) * 100;

    const previsao = classificarPrevisao(diffPercentual);
    const golsTotaisReais = partida.gols_casa + partida.gols_fora;
    const acertou = avaliarAcerto(golsTotaisReais, previsao);

    mostradas++;

    const nomeCasa = partida.times_casa?.nome || `Time ${partida.time_casa_id}`;
    const nomeFora = partida.times_fora?.nome || `Time ${partida.time_fora_id}`;

    const rotuloPrevisao = {
      '0': '0 gols (nenhum)',
      '1': '1 ou mais gols',
      '2': '2 ou mais gols',
      '3+': '3 ou mais gols',
      'nula': 'aposta nula (sem previsão)',
    }[previsao];

    console.log(`--- Jogo ${mostradas}: ${nomeCasa} x ${nomeFora} (${new Date(partida.data_hora).toLocaleDateString('pt-BR')}) ---`);
    console.log(`  Média ${nomeCasa} como mandante (últimos ${jogosMandante.length}): ${mediaMandante.toFixed(2)}`);
    console.log(`  Média ${nomeFora} como visitante (últimos ${jogosVisitante.length}): ${mediaVisitante.toFixed(2)}`);
    console.log(`  Média do confronto: ${mediaConfronto.toFixed(2)}  |  Média da liga: ${mediaLiga.toFixed(2)}`);
    console.log(`  Diferença percentual: ${diffPercentual >= 0 ? '+' : ''}${diffPercentual.toFixed(1)}%  →  previsão: ${rotuloPrevisao}`);
    console.log(`  Gols reais na partida: ${partida.gols_casa} x ${partida.gols_fora} = ${golsTotaisReais} gols totais`);
    if (previsao === 'nula') {
      console.log(`  (Não avaliado -- faixa "aposta nula")\n`);
    } else {
      console.log(`  ${acertou ? '✅ ACERTOU' : '❌ ERROU'}\n`);
    }
  }

  console.log(`\n(Mostrados ${mostradas} jogos. Pra ver mais, roda com --jogos=60 por exemplo.)`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
