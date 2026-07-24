/**
 * regras-percentual-gols.js
 *
 * Testa o sistema de faixas percentuais proposto:
 *
 *  diff% = (média do confronto - média da liga) / média da liga × 100
 *
 *  diff% > +30%           → sugere 3+ gols na partida
 *  diff% entre +10% e +30% → sugere 2 gols na partida
 *  diff% entre -10% e +10% → sugere 1 gol na partida
 *  diff% entre -50% e -10% → aposta nula (sem previsão confiável)
 *  diff% < -50%            → sugere partida sem gols (0 gols)
 *
 * Testa contra o resultado REAL (gols totais da partida), medindo a taxa de
 * acerto de cada faixa -- usando walk-forward, sem olhar o futuro.
 *
 * Uso:
 *   node scripts/regras-percentual-gols.js --competicao=71 --janela=10
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

function classificarPrevisao(diffPercentual) {
  if (diffPercentual > 30) return '3+';
  if (diffPercentual > 10) return '2';
  if (diffPercentual >= -10) return '1';
  if (diffPercentual >= -50) return 'nula';
  return '0';
}

function classificarResultadoReal(golsTotais, previsao) {
  // Compara o resultado real com o TIPO de previsão feita.
  // "1" e "2" são faixas CUMULATIVAS (1 ou mais, 2 ou mais), não exatas.
  if (previsao === '3+') return golsTotais >= 3;
  if (previsao === '2') return golsTotais >= 2;
  if (previsao === '1') return golsTotais >= 1;
  if (previsao === '0') return golsTotais === 0;
  return null; // 'nula' não é avaliada
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const janelaArg = args.find((a) => a.startsWith('--janela='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;
  const JANELA = janelaArg ? parseInt(janelaArg.split('=')[1], 10) : 10;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  console.log(`Carregando partidas de: ${comp.nome} (janela de ${JANELA} jogos)...`);
  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  if (error) throw error;
  console.log(`${todasPartidas.length} partidas carregadas.\n`);

  const contagem = {
    '0': { previstos: 0, acertos: 0 },
    '1': { previstos: 0, acertos: 0 },
    '2': { previstos: 0, acertos: 0 },
    '3+': { previstos: 0, acertos: 0 },
    'nula': { previstos: 0 },
  };

  let totalAnalisado = 0;

  for (let i = 0; i < todasPartidas.length; i++) {
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

    totalAnalisado++;
    contagem[previsao].previstos++;

    if (previsao !== 'nula') {
      const acertou = classificarResultadoReal(golsTotaisReais, previsao);
      if (acertou) contagem[previsao].acertos++;
    }
  }

  console.log(`Total de partidas analisadas: ${totalAnalisado}\n`);
  console.log('=== Resultado por faixa de previsão ===\n');

  for (const chave of ['0', '1', '2', '3+', 'nula']) {
    const c = contagem[chave];
    if (chave === 'nula') {
      console.log(`Faixa "aposta nula": ${c.previstos} jogos (${((c.previstos / totalAnalisado) * 100).toFixed(1)}% do total) -- não avaliados`);
      continue;
    }
    if (c.previstos === 0) {
      console.log(`Faixa "${chave} gol(s)": 0 jogos previstos.`);
      continue;
    }
    const taxaAcerto = (c.acertos / c.previstos) * 100;
    console.log(`Faixa "${chave} gol(s)": ${c.previstos} jogos previstos, ${c.acertos} acertos (${taxaAcerto.toFixed(1)}%)`);
  }

  console.log('\n=== Referência: frequência real de cada faixa (cumulativa) no campeonato inteiro ===');
  const todosOsGolsReais = [];
  for (let i = 0; i < todasPartidas.length; i++) {
    todosOsGolsReais.push(todasPartidas[i].gols_casa + todasPartidas[i].gols_fora);
  }
  const pct0 = (todosOsGolsReais.filter((g) => g === 0).length / todosOsGolsReais.length) * 100;
  console.log(`  Exatamente 0 gols: ${pct0.toFixed(1)}% dos jogos`);
  for (const alvo of [1, 2, 3]) {
    const pct = (todosOsGolsReais.filter((g) => g >= alvo).length / todosOsGolsReais.length) * 100;
    console.log(`  ${alvo}+ gols: ${pct.toFixed(1)}% dos jogos`);
  }
  console.log('\n(Compare a taxa de acerto de cada faixa com a frequência real correspondente -- se a faixa "2"');
  console.log('(2+ gols) acerta bem mais que a frequência natural de jogos com 2+ gols, é sinal de que a regra');
  console.log('funciona pra essa faixa.)');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
