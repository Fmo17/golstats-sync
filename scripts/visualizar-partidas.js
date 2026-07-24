/**
 * visualizar-partidas.js
 *
 * Mostra, PARTIDA POR PARTIDA, exatamente o raciocínio que o modelo faz --
 * pra você conferir com os próprios olhos, no formato que você descreveu:
 * "o mandante tem média de gols maior que a média da liga? o visitante tem
 * média de gols sofridos maior que a média da liga? o resultado bateu?"
 *
 * Uso:
 *   node scripts/visualizar-partidas.js --competicao=71 --rodadas=15
 *   (mostra a partir de quando cada time já tem histórico suficiente, até a
 *   rodada indicada)
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
const MINIMO_JOGOS = 3;

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const rodadasArg = args.find((a) => a.startsWith('--rodadas='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;
  const numJogosMostrar = rodadasArg ? parseInt(rodadasArg.split('=')[1], 10) * 10 : 100; // ~10 jogos por rodada, aproximado

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, rodada, time_casa_id, time_fora_id, gols_casa, gols_fora, times_casa:times!partidas_time_casa_id_fkey(nome), times_fora:times!partidas_time_fora_id_fkey(nome)')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  if (error) throw error;

  console.log(`${comp.nome} -- ${todasPartidas.length} partidas no banco.\n`);
  console.log('Mostrando partida por partida (só quando os 2 times já têm histórico suficiente):\n');

  let mostradas = 0;
  let acertos = 0;

  for (let i = 0; i < todasPartidas.length && mostradas < numJogosMostrar; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    // Média de gols do time da casa, jogando em casa, até agora
    const jogosCasaTimeCasa = anteriores.filter((p) => p.time_casa_id === partida.time_casa_id);
    if (jogosCasaTimeCasa.length < MINIMO_JOGOS) continue;
    const mediaGolsFeitosCasa = jogosCasaTimeCasa.reduce((s, p) => s + p.gols_casa, 0) / jogosCasaTimeCasa.length;

    // Média de gols sofridos pelo time de fora, jogando fora, até agora
    const jogosForaTimeFora = anteriores.filter((p) => p.time_fora_id === partida.time_fora_id);
    if (jogosForaTimeFora.length < MINIMO_JOGOS) continue;
    const mediaGolsSofridosFora = jogosForaTimeFora.reduce((s, p) => s + p.gols_casa, 0) / jogosForaTimeFora.length;

    // Médias gerais da liga até agora (todos os jogos em casa / todos os jogos fora)
    if (anteriores.length < 10) continue; // precisa de uma base mínima pra média da liga fazer sentido
    const mediaLigaGolsCasa = anteriores.reduce((s, p) => s + p.gols_casa, 0) / anteriores.length;
    const mediaLigaGolsFora_comoSofrido = anteriores.reduce((s, p) => s + p.gols_casa, 0) / anteriores.length; // gols sofridos por quem joga fora = gols_casa de cada partida

    const diferencaAtaque = mediaGolsFeitosCasa - mediaLigaGolsCasa; // positivo = mandante ataca melhor que a média
    const diferencaDefesa = mediaGolsSofridosFora - mediaLigaGolsFora_comoSofrido; // positivo = visitante sofre mais que a média (defesa fraca)

    const fatorTotal = diferencaAtaque + diferencaDefesa;
    const previsaoFavoreceCasa = fatorTotal > 0.15; // limiar simples, só pra ilustrar a lógica

    let resultadoReal;
    if (partida.gols_casa > partida.gols_fora) resultadoReal = 'CASA venceu';
    else if (partida.gols_casa === partida.gols_fora) resultadoReal = 'EMPATE';
    else resultadoReal = 'FORA venceu';

    const bateu = (previsaoFavoreceCasa && resultadoReal === 'CASA venceu') || (!previsaoFavoreceCasa && resultadoReal !== 'CASA venceu');
    if (bateu) acertos++;

    mostradas++;

    const nomeCasa = partida.times_casa?.nome || `Time ${partida.time_casa_id}`;
    const nomeFora = partida.times_fora?.nome || `Time ${partida.time_fora_id}`;

    console.log(`--- Jogo ${mostradas}: ${nomeCasa} x ${nomeFora} (${new Date(partida.data_hora).toLocaleDateString('pt-BR')}) ---`);
    console.log(`  ${nomeCasa} (casa): média de gols feitos em casa até agora = ${mediaGolsFeitosCasa.toFixed(2)} | média da liga (casa) = ${mediaLigaGolsCasa.toFixed(2)} | diferença = ${diferencaAtaque >= 0 ? '+' : ''}${diferencaAtaque.toFixed(2)}`);
    console.log(`  ${nomeFora} (fora): média de gols sofridos fora até agora = ${mediaGolsSofridosFora.toFixed(2)} | média da liga (sofrido fora) = ${mediaLigaGolsFora_comoSofrido.toFixed(2)} | diferença = ${diferencaDefesa >= 0 ? '+' : ''}${diferencaDefesa.toFixed(2)}`);
    console.log(`  Fator combinado: ${fatorTotal.toFixed(2)} → previsão: ${previsaoFavoreceCasa ? 'favorece o mandante' : 'NÃO favorece claramente o mandante'}`);
    console.log(`  Resultado real: ${resultadoReal} (${partida.gols_casa} x ${partida.gols_fora})  ${bateu ? '✅ bateu' : '❌ não bateu'}\n`);
  }

  console.log(`\n=== Resumo dos ${mostradas} jogos mostrados ===`);
  console.log(`Acertos: ${acertos} de ${mostradas} (${((acertos / mostradas) * 100).toFixed(1)}%)`);
  console.log('\n(Esse número usa um limiar simples de exemplo (0.15), só pra ilustrar o raciocínio --');
  console.log('não é o modelo final calibrado, que já testamos em scripts/calcular-sinais.js.)');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
