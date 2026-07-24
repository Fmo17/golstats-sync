/**
 * comparacao-gols-liga.js
 *
 * Testa exatamente a lógica descrita com o exemplo Palmeiras x Santos:
 *
 * 1. Média de gols do MANDANTE especificamente jogando EM CASA (só os jogos
 *    dele como mandante contam, não qualquer jogo)
 * 2. Média de gols do VISITANTE especificamente jogando FORA (só os jogos
 *    dele como visitante contam)
 * 3. Média geral de gols por partida da competição inteira até aquele ponto
 * 4. Média do confronto = (média do mandante + média do visitante) / 2
 * 5. Compara a média do confronto com a média geral da liga
 * 6. Testa se isso ajuda a prever quantos gols (0, 1, 2+, 3+) vão sair na
 *    partida
 *
 * Testa em 3 janelas (últimos 5, 10 e 15 jogos de cada time, no seu mando
 * específico) -- walk-forward, sem olhar o futuro, e comparando sempre com a
 * taxa real DENTRO do subconjunto filtrado (não a taxa geral do campeonato).
 *
 * Uso:
 *   node scripts/comparacao-gols-liga.js --competicao=71
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

// 1. Média de gols do time jogando especificamente EM CASA (mandante)
function mediaGolsComoMandante(partidasAnteriores, timeId, janela) {
  const jogos = partidasAnteriores.filter((p) => p.time_casa_id === timeId).slice(-janela);
  if (jogos.length === 0) return null;
  const soma = jogos.reduce((s, p) => s + p.gols_casa, 0);
  return { media: soma / jogos.length, amostra: jogos.length };
}

// 2. Média de gols do time jogando especificamente FORA (visitante)
function mediaGolsComoVisitante(partidasAnteriores, timeId, janela) {
  const jogos = partidasAnteriores.filter((p) => p.time_fora_id === timeId).slice(-janela);
  if (jogos.length === 0) return null;
  const soma = jogos.reduce((s, p) => s + p.gols_fora, 0);
  return { media: soma / jogos.length, amostra: jogos.length };
}

async function testarJanela(todasPartidas, janela) {
  console.log(`\n=== Janela de ${janela} jogos ===`);

  const inicioValido = Math.floor(todasPartidas.length * 0.2);
  const fatores = [];
  const golsReaisTotais = [];

  for (let i = inicioValido; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    // 1. Média de gols do mandante, jogando em casa
    const infoMandante = mediaGolsComoMandante(anteriores, partida.time_casa_id, janela);
    if (!infoMandante || infoMandante.amostra < 3) continue;

    // 2. Média de gols do visitante, jogando fora
    const infoVisitante = mediaGolsComoVisitante(anteriores, partida.time_fora_id, janela);
    if (!infoVisitante || infoVisitante.amostra < 3) continue;

    if (anteriores.length < 10) continue;

    // 3. Média geral de gols por partida da competição, dividida por 2 pra
    //    ficar na mesma escala da média do confronto (gols de UM time, não
    //    o total dos dois somados).
    const mediaLigaTotal = anteriores.reduce((s, p) => s + p.gols_casa + p.gols_fora, 0) / anteriores.length;
    const mediaLiga = mediaLigaTotal / 2;

    // 4. Média do confronto = (média mandante + média visitante) / 2
    const mediaConfronto = (infoMandante.media + infoVisitante.media) / 2;

    // 5. Fator = diferença entre a média do confronto e a média da liga
    const fator = mediaConfronto - mediaLiga;

    // 6. Gols reais que saíram na partida (total, os 2 lados)
    const golsTotaisReais = partida.gols_casa + partida.gols_fora;

    fatores.push(fator);
    golsReaisTotais.push(golsTotaisReais);
  }

  console.log(`  Partidas analisadas: ${fatores.length}`);
  if (fatores.length < 20) {
    console.log('  Amostra pequena demais, pulando essa janela.');
    return;
  }

  const r = correlacaoPearson(fatores, golsReaisTotais);
  console.log(`  Correlação (fator × total de gols reais na partida): r = ${r.toFixed(3)}`);

  const limiares = [-0.5, -0.2, 0, 0.2, 0.5, 0.8, 1.0];

  for (const minimoGols of [1, 2, 3]) {
    console.log(`\n  --- Prevendo "a partida vai ter ${minimoGols}+ gols (total)" ---`);
    const taxaBaseGeral = (golsReaisTotais.filter((g) => g >= minimoGols).length / golsReaisTotais.length) * 100;
    console.log(`  Taxa geral (${minimoGols}+ gols, campeonato inteiro): ${taxaBaseGeral.toFixed(1)}%`);
    console.log(`  Limiar | Jogos no subconjunto | Taxa real de ${minimoGols}+ gols nesse subconjunto`);

    for (const limiar of limiares) {
      const indices = fatores.map((f, idx) => (f > limiar ? idx : -1)).filter((idx) => idx >= 0);
      if (indices.length < 20) continue;
      const golsSubconjunto = indices.map((idx) => golsReaisTotais[idx]);
      const taxaSubconjunto = (golsSubconjunto.filter((g) => g >= minimoGols).length / golsSubconjunto.length) * 100;
      console.log(`  ${limiar.toFixed(1).padEnd(6)} | ${String(indices.length).padEnd(20)} | ${taxaSubconjunto.toFixed(1)}%`);
    }
  }

  // Bônus: chance de a partida terminar SEM NENHUM GOL (0 gols)
  const taxaZeroGols = (golsReaisTotais.filter((g) => g === 0).length / golsReaisTotais.length) * 100;
  console.log(`\n  --- Referência: taxa geral de partidas com 0 gols no campeonato inteiro: ${taxaZeroGols.toFixed(1)}% ---`);
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  console.log(`Carregando partidas de: ${comp.nome}...`);
  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  if (error) throw error;
  console.log(`${todasPartidas.length} partidas carregadas.`);

  for (const janela of [5, 10, 15]) {
    await testarJanela(todasPartidas, janela);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
