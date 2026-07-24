/**
 * validar-limiar-fixo.js
 *
 * Valida FORA DA AMOSTRA um limiar já escolhido (não reotimiza nada aqui --
 * só aplica a regra fixa "combinação MÍNIMO das frequências de gol, limiar
 * 0.6" que veio como vencedora no teste feito na Série A).
 *
 * O objetivo é justamente NÃO deixar o script escolher o melhor limiar pra
 * cada competição (isso seria reintroduzir o viés de seleção que estamos
 * tentando evitar) -- aplicamos o mesmo número fixo em todo lugar e vemos se
 * ele se sustenta.
 *
 * Uso:
 *   node scripts/validar-limiar-fixo.js
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

// Limiar fixo, decidido a partir do teste na Série A -- NÃO reotimizamos aqui.
const LIMIAR_FIXO = 0.6;

function frequenciaMarcou(jogos, timeId) {
  const marcou = jogos.filter((j) => {
    const golsDoTime = j.time_casa_id === timeId ? j.gols_casa : j.gols_fora;
    return golsDoTime >= 1;
  }).length;
  return marcou / jogos.length;
}

async function validarCompeticao(apiFootballId) {
  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) {
    console.log(`Competição ${apiFootballId} não encontrada.`);
    return;
  }

  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id)
    .eq('status', 'finalizado')
    .not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  if (error) throw error;

  const inicioValido = Math.floor(todasPartidas.length * 0.2);
  let verdadeirosPositivos = 0, falsosPositivos = 0, verdadeirosNegativos = 0, falsosNegativos = 0;
  let totalBTTS = 0, totalTestado = 0;

  for (let i = inicioValido; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    const jogosTimeCasa = anteriores
      .filter((p) => p.time_casa_id === partida.time_casa_id || p.time_fora_id === partida.time_casa_id)
      .slice(-JANELA);
    const jogosTimeFora = anteriores
      .filter((p) => p.time_casa_id === partida.time_fora_id || p.time_fora_id === partida.time_fora_id)
      .slice(-JANELA);

    if (jogosTimeCasa.length < 5 || jogosTimeFora.length < 5) continue;

    const freqCasa = frequenciaMarcou(jogosTimeCasa, partida.time_casa_id);
    const freqFora = frequenciaMarcou(jogosTimeFora, partida.time_fora_id);
    const fatorMinimo = Math.min(freqCasa, freqFora);

    const previuBTTS = fatorMinimo > LIMIAR_FIXO;
    const bttsReal = partida.gols_casa >= 1 && partida.gols_fora >= 1;

    totalTestado++;
    if (bttsReal) totalBTTS++;

    if (previuBTTS && bttsReal) verdadeirosPositivos++;
    if (previuBTTS && !bttsReal) falsosPositivos++;
    if (!previuBTTS && !bttsReal) verdadeirosNegativos++;
    if (!previuBTTS && bttsReal) falsosNegativos++;
  }

  const taxaAcerto = ((verdadeirosPositivos + verdadeirosNegativos) / totalTestado) * 100;
  const taxaBTTS = (totalBTTS / totalTestado) * 100;
  const melhorLinhaBase = Math.max(taxaBTTS, 100 - taxaBTTS);

  console.log(`\n=== ${comp.nome} ===`);
  console.log(`  Partidas testadas: ${totalTestado}`);
  console.log(`  Taxa real de BTTS nessa amostra: ${taxaBTTS.toFixed(1)}%`);
  console.log(`  Melhor linha de base possível: ${melhorLinhaBase.toFixed(1)}%`);
  console.log(`  Taxa de acerto com limiar fixo (mínimo, 0.6): ${taxaAcerto.toFixed(1)}%`);
  console.log(`  ${taxaAcerto > melhorLinhaBase ? '✅ SUPERA' : '❌ NÃO supera'} a linha de base`);

  return { nome: comp.nome, taxaAcerto, melhorLinhaBase, totalTestado };
}

async function main() {
  console.log(`Validando limiar fixo (combinação MÍNIMO, limiar ${LIMIAR_FIXO}) em outras competições...`);
  console.log('(Esse limiar foi escolhido olhando SÓ pra Série A -- aqui só aplicamos, sem reajustar.)\n');

  const resultados = [];
  // Série B (72) e Série C (75) -- os api_football_id reais confirmados no projeto
  for (const apiFootballId of [72, 75]) {
    const r = await validarCompeticao(apiFootballId);
    if (r) resultados.push(r);
  }

  console.log('\n\n=== Resumo da validação fora da amostra ===');
  for (const r of resultados) {
    const status = r.taxaAcerto > r.melhorLinhaBase ? '✅' : '❌';
    console.log(`${status} ${r.nome}: ${r.taxaAcerto.toFixed(1)}% vs linha de base ${r.melhorLinhaBase.toFixed(1)}% (${r.totalTestado} jogos)`);
  }
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
