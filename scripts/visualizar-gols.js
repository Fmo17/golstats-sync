/**
 * visualizar-gols.js
 *
 * Mostra, PARTIDA POR PARTIDA, o raciocínio da hipótese de gols totais:
 * média do mandante como mandante, média do visitante como visitante, média
 * da liga (na mesma escala, dividida por 2), e quantos gols realmente saíram.
 *
 * Uso:
 *   node scripts/visualizar-gols.js --competicao=71 --jogos=30 --janela=10
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
  const jogosArg = args.find((a) => a.startsWith('--jogos='));
  const janelaArg = args.find((a) => a.startsWith('--janela='));

  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;
  const numJogosMostrar = jogosArg ? parseInt(jogosArg.split('=')[1], 10) : 30;
  const JANELA = janelaArg ? parseInt(janelaArg.split('=')[1], 10) : 10;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora, times_casa:times!partidas_time_casa_id_fkey(nome), times_fora:times!partidas_time_fora_id_fkey(nome)')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  if (error) throw error;

  console.log(`${comp.nome} -- ${todasPartidas.length} partidas no banco. Janela de ${JANELA} jogos.\n`);
  console.log('Mostrando partida por partida (só quando os 2 times já têm histórico suficiente no seu mando específico):\n');

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
    const fator = mediaConfronto - mediaLiga;

    const golsReaisTotais = partida.gols_casa + partida.gols_fora;

    mostradas++;

    const nomeCasa = partida.times_casa?.nome || `Time ${partida.time_casa_id}`;
    const nomeFora = partida.times_fora?.nome || `Time ${partida.time_fora_id}`;

    console.log(`--- Jogo ${mostradas}: ${nomeCasa} x ${nomeFora} (${new Date(partida.data_hora).toLocaleDateString('pt-BR')}) ---`);
    console.log(`  ${nomeCasa} (mandante): média de gols feitos como mandante (últimos ${jogosMandante.length} jogos em casa) = ${mediaMandante.toFixed(2)}`);
    console.log(`  ${nomeFora} (visitante): média de gols feitos como visitante (últimos ${jogosVisitante.length} jogos fora) = ${mediaVisitante.toFixed(2)}`);
    console.log(`  Média do confronto: (${mediaMandante.toFixed(2)} + ${mediaVisitante.toFixed(2)}) ÷ 2 = ${mediaConfronto.toFixed(2)}`);
    console.log(`  Média da liga (por time, já dividida por 2): ${mediaLiga.toFixed(2)}`);
    console.log(`  Fator (confronto − liga): ${fator >= 0 ? '+' : ''}${fator.toFixed(2)} → ${fator > 0 ? 'sugere MAIS gols que o normal' : 'sugere MENOS gols que o normal'}`);
    console.log(`  Gols reais na partida: ${partida.gols_casa} x ${partida.gols_fora} = ${golsReaisTotais} gols totais`);
    console.log(`  Resultado: ${golsReaisTotais >= 3 ? 'jogo com MUITOS gols (3+)' : golsReaisTotais <= 1 ? 'jogo com POUCOS gols (0-1)' : 'jogo mediano (2 gols)'}\n`);
  }

  console.log(`\n(Mostrados ${mostradas} jogos. Pra ver mais, roda de novo com --jogos=60 por exemplo.)`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
