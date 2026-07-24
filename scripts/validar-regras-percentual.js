/**
 * validar-regras-percentual.js
 *
 * Aplica a MESMA regra percentual (sem reajustar nada) nas outras
 * competições, focando nas faixas "2" e "3+" que mostraram vantagem modesta
 * na Série A.
 *
 * Uso:
 *   node scripts/validar-regras-percentual.js
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

async function validarCompeticao(apiFootballId) {
  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.log(`Competição ${apiFootballId} não encontrada.`); return; }

  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  if (error) throw error;

  const contagem = { '2': { previstos: 0, acertos: 0 }, '3+': { previstos: 0, acertos: 0 } };
  let totalAnalisado = 0;
  const todosOsGolsReais = [];

  for (let i = 0; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);
    todosOsGolsReais.push(partida.gols_casa + partida.gols_fora);

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

    totalAnalisado++;

    if (previsao === '2') {
      contagem['2'].previstos++;
      if (golsTotaisReais >= 2) contagem['2'].acertos++;
    }
    if (previsao === '3+') {
      contagem['3+'].previstos++;
      if (golsTotaisReais >= 3) contagem['3+'].acertos++;
    }
  }

  const freq2mais = (todosOsGolsReais.filter((g) => g >= 2).length / todosOsGolsReais.length) * 100;
  const freq3mais = (todosOsGolsReais.filter((g) => g >= 3).length / todosOsGolsReais.length) * 100;

  console.log(`\n=== ${comp.nome} ===`);
  const taxa2 = contagem['2'].previstos > 0 ? (contagem['2'].acertos / contagem['2'].previstos) * 100 : 0;
  const taxa3 = contagem['3+'].previstos > 0 ? (contagem['3+'].acertos / contagem['3+'].previstos) * 100 : 0;
  console.log(`  Faixa "2" (2+ gols): ${contagem['2'].previstos} jogos, acerto ${taxa2.toFixed(1)}%  |  referência (2+ gols no campeonato): ${freq2mais.toFixed(1)}%  ${taxa2 > freq2mais ? '✅' : '❌'}`);
  console.log(`  Faixa "3+" (3+ gols): ${contagem['3+'].previstos} jogos, acerto ${taxa3.toFixed(1)}%  |  referência (3+ gols no campeonato): ${freq3mais.toFixed(1)}%  ${taxa3 > freq3mais ? '✅' : '❌'}`);
}

async function main() {
  console.log('Validando a regra percentual (faixas "2" e "3+") fora da amostra da Série A...');
  for (const apiFootballId of [72, 75, 76]) {
    await validarCompeticao(apiFootballId);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
