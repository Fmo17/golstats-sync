/**
 * frequencia-gols.js
 *
 * Testa a hipótese: "frequência de rodadas que uma equipe marca gol" +
 * "frequência de rodadas que o adversário marca gol" ajuda a prever se vai
 * sair gol dos dois lados na partida (ambas marcam / BTTS)?
 *
 * Frequência aqui = em quantos % dos últimos jogos aquele time marcou pelo
 * menos 1 gol (não importa se ganhou ou perdeu, só se ele balançou a rede).
 *
 * Testa 3 formas de combinar a frequência dos dois times:
 *  - Média:  (freqCasa + freqFora) / 2
 *  - Mínimo: o menor dos dois (lógica: "ambas marcam" só acontece se o time
 *            que marca MENOS ainda assim conseguir marcar -- então o elo
 *            mais fraco deveria pesar mais que a média)
 *  - Produto: freqCasa × freqFora (penaliza mais forte quando qualquer um
 *             dos dois tem frequência baixa)
 *
 * Uso:
 *   node scripts/frequencia-gols.js --competicao=71
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

function avaliarLimiar(fatores, resultadosReais, limiar) {
  let verdadeirosPositivos = 0, falsosPositivos = 0, verdadeirosNegativos = 0, falsosNegativos = 0;
  for (let i = 0; i < fatores.length; i++) {
    const previuBTTS = fatores[i] > limiar;
    const btttsReal = resultadosReais[i];
    if (previuBTTS && btttsReal) verdadeirosPositivos++;
    if (previuBTTS && !btttsReal) falsosPositivos++;
    if (!previuBTTS && !btttsReal) verdadeirosNegativos++;
    if (!previuBTTS && btttsReal) falsosNegativos++;
  }
  const total = fatores.length;
  return {
    taxaAcerto: ((verdadeirosPositivos + verdadeirosNegativos) / total) * 100,
    verdadeirosPositivos, falsosPositivos, verdadeirosNegativos, falsosNegativos,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) {
    console.error('Competição não encontrada.');
    return;
  }

  console.log(`Carregando partidas de: ${comp.nome}...`);
  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id)
    .eq('status', 'finalizado')
    .not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  if (error) throw error;
  console.log(`${todasPartidas.length} partidas carregadas.\n`);

  const inicioValido = Math.floor(todasPartidas.length * 0.2);
  const fatoresMedia = [];
  const fatoresMinimo = [];
  const fatoresProduto = [];
  const resultadosBTTS = [];

  for (let i = inicioValido; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    // Últimos N jogos de cada time, qualquer mando de campo
    const jogosTimeCasa = anteriores
      .filter((p) => p.time_casa_id === partida.time_casa_id || p.time_fora_id === partida.time_casa_id)
      .slice(-JANELA);
    const jogosTimeFora = anteriores
      .filter((p) => p.time_casa_id === partida.time_fora_id || p.time_fora_id === partida.time_fora_id)
      .slice(-JANELA);

    if (jogosTimeCasa.length < 5 || jogosTimeFora.length < 5) continue;

    function frequenciaMarcou(jogos, timeId) {
      const marcou = jogos.filter((j) => {
        const golsDoTime = j.time_casa_id === timeId ? j.gols_casa : j.gols_fora;
        return golsDoTime >= 1;
      }).length;
      return marcou / jogos.length;
    }

    const freqCasa = frequenciaMarcou(jogosTimeCasa, partida.time_casa_id);
    const freqFora = frequenciaMarcou(jogosTimeFora, partida.time_fora_id);

    fatoresMedia.push((freqCasa + freqFora) / 2);
    fatoresMinimo.push(Math.min(freqCasa, freqFora));
    fatoresProduto.push(freqCasa * freqFora);

    const bttsReal = partida.gols_casa >= 1 && partida.gols_fora >= 1;
    resultadosBTTS.push(bttsReal);
  }

  console.log(`Partidas usadas na análise: ${fatoresMedia.length}`);

  const taxaBaseBTTS = (resultadosBTTS.filter((x) => x).length / resultadosBTTS.length) * 100;
  console.log(`Taxa real de "ambas marcam" nessa amostra: ${taxaBaseBTTS.toFixed(1)}%`);
  console.log(`(Linha de base: prever sempre "sim" acerta ${taxaBaseBTTS.toFixed(1)}%; prever sempre "não" acerta ${(100 - taxaBaseBTTS).toFixed(1)}%)\n`);

  const candidatos = [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8];

  function testarCombinacao(nome, fatores) {
    console.log(`=== Combinação: ${nome} ===`);
    let melhor = null;
    for (const limiar of candidatos) {
      const r = avaliarLimiar(fatores, resultadosBTTS, limiar);
      console.log(`  Limiar ${limiar.toFixed(2)}: acerto ${r.taxaAcerto.toFixed(1)}%  (VP=${r.verdadeirosPositivos} FP=${r.falsosPositivos} VN=${r.verdadeirosNegativos} FN=${r.falsosNegativos})`);
      if (!melhor || r.taxaAcerto > melhor.taxaAcerto) melhor = { limiar, ...r };
    }
    const baseline = Math.max(taxaBaseBTTS, 100 - taxaBaseBTTS);
    console.log(`  Melhor: limiar ${melhor.limiar} → ${melhor.taxaAcerto.toFixed(1)}%  ${melhor.taxaAcerto > baseline ? '✅ SUPERA' : '❌ NÃO supera'} a melhor linha de base (${baseline.toFixed(1)}%)\n`);
    return melhor;
  }

  const resultadoMedia = testarCombinacao('MÉDIA das frequências', fatoresMedia);
  const resultadoMinimo = testarCombinacao('MÍNIMO das frequências (elo mais fraco)', fatoresMinimo);
  const resultadoProduto = testarCombinacao('PRODUTO das frequências', fatoresProduto);

  console.log('=== Resumo final ===');
  const baseline = Math.max(taxaBaseBTTS, 100 - taxaBaseBTTS);
  console.log(`Melhor linha de base possível: ${baseline.toFixed(1)}%`);
  console.log(`Melhor com MÉDIA: ${resultadoMedia.taxaAcerto.toFixed(1)}%`);
  console.log(`Melhor com MÍNIMO: ${resultadoMinimo.taxaAcerto.toFixed(1)}%`);
  console.log(`Melhor com PRODUTO: ${resultadoProduto.taxaAcerto.toFixed(1)}%`);
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
