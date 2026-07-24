/**
 * limiar-decisao.js
 *
 * Busca um "ponto de corte" (razão/limiar) entre gols feitos em casa (histórico)
 * e gols sofridos fora (histórico do adversário) que sirva como regra prática
 * pra prever "esse time vai marcar pelo menos 1 gol nessa partida?" -- na mesma
 * lógica da regra do etanol/gasolina (calcula uma razão, acha o ponto de corte
 * que melhor separa "vale a pena" de "não vale a pena").
 *
 * Testa VÁRIOS pontos de corte possíveis e reporta qual deles tem a melhor
 * taxa de acerto, comparado com a linha de base ingênua ("sempre prever que
 * vai marcar pelo menos 1 gol").
 *
 * Uso:
 *   node scripts/limiar-decisao.js --competicao=71
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

/**
 * Testa um limiar específico: "se fator > limiar, prevê que vai marcar 1+ gol".
 * Devolve acertos, e a matriz de confusão (quantos acertou/errou em cada direção).
 */
function avaliarLimiar(fatores, resultadosReais, limiar) {
  let acertos = 0;
  let verdadeirosPositivos = 0, falsosPositivos = 0, verdadeirosNegativos = 0, falsosNegativos = 0;

  for (let i = 0; i < fatores.length; i++) {
    const previu1Gol = fatores[i] > limiar;
    const marcouDeVerdade = resultadosReais[i];

    if (previu1Gol === marcouDeVerdade) acertos++;

    if (previu1Gol && marcouDeVerdade) verdadeirosPositivos++;
    if (previu1Gol && !marcouDeVerdade) falsosPositivos++;
    if (!previu1Gol && !marcouDeVerdade) verdadeirosNegativos++;
    if (!previu1Gol && marcouDeVerdade) falsosNegativos++;
  }

  return {
    taxaAcerto: (acertos / fatores.length) * 100,
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

  // Vamos testar 2 formas de combinar X e Y: razão (X/Y) e diferença (X-Y)
  const fatoresRazao = [];
  const fatoresDiferenca = [];
  const resultadosReais = []; // true = time da casa marcou pelo menos 1 gol

  for (let i = inicioValido; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    const jogosCasaTimeCasa = anteriores.filter((p) => p.time_casa_id === partida.time_casa_id).slice(-JANELA);
    const jogosForaTimeFora = anteriores.filter((p) => p.time_fora_id === partida.time_fora_id).slice(-JANELA);

    if (jogosCasaTimeCasa.length < 3 || jogosForaTimeFora.length < 3) continue;

    const mediaGolsFeitosCasa = jogosCasaTimeCasa.reduce((s, j) => s + j.gols_casa, 0) / jogosCasaTimeCasa.length;
    const mediaGolsSofridosFora = jogosForaTimeFora.reduce((s, j) => s + j.gols_casa, 0) / jogosForaTimeFora.length;

    fatoresRazao.push(mediaGolsFeitosCasa / Math.max(mediaGolsSofridosFora, 0.1)); // evita divisão por zero
    fatoresDiferenca.push(mediaGolsFeitosCasa - mediaGolsSofridosFora);
    resultadosReais.push(partida.gols_casa >= 1);
  }

  console.log(`Partidas usadas na análise: ${fatoresRazao.length}`);

  const taxaBaseMarcou = (resultadosReais.filter((r) => r).length / resultadosReais.length) * 100;
  console.log(`Linha de base ("sempre prever que marca 1+ gol"): ${taxaBaseMarcou.toFixed(1)}%\n`);

  // ---------- Busca do melhor limiar para a RAZÃO (X/Y) ----------
  console.log('=== Testando limiares pra RAZÃO (gols feitos em casa ÷ gols sofridos fora) ===\n');
  const candidatosRazao = [0.5, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 1.8, 2.0];
  let melhorRazao = null;

  for (const limiar of candidatosRazao) {
    const r = avaliarLimiar(fatoresRazao, resultadosReais, limiar);
    console.log(`  Limiar ${limiar.toFixed(1)}: taxa de acerto ${r.taxaAcerto.toFixed(1)}%  (acertou marca: ${r.verdadeirosPositivos}, acertou não-marca: ${r.verdadeirosNegativos}, errou: ${r.falsosPositivos + r.falsosNegativos})`);
    if (!melhorRazao || r.taxaAcerto > melhorRazao.taxaAcerto) melhorRazao = { limiar, ...r };
  }

  console.log(`\n  Melhor limiar de razão encontrado: ${melhorRazao.limiar.toFixed(1)} → ${melhorRazao.taxaAcerto.toFixed(1)}% de acerto`);
  console.log(`  ${melhorRazao.taxaAcerto > taxaBaseMarcou ? '✅ SUPERA' : '❌ NÃO supera'} a linha de base (${taxaBaseMarcou.toFixed(1)}%)\n`);

  // ---------- Busca do melhor limiar para a DIFERENÇA (X - Y) ----------
  console.log('=== Testando limiares pra DIFERENÇA (gols feitos em casa − gols sofridos fora) ===\n');
  const candidatosDiferenca = [-1.0, -0.5, -0.2, 0, 0.2, 0.5, 1.0];
  let melhorDiferenca = null;

  for (const limiar of candidatosDiferenca) {
    const r = avaliarLimiar(fatoresDiferenca, resultadosReais, limiar);
    console.log(`  Limiar ${limiar.toFixed(1)}: taxa de acerto ${r.taxaAcerto.toFixed(1)}%  (acertou marca: ${r.verdadeirosPositivos}, acertou não-marca: ${r.verdadeirosNegativos}, errou: ${r.falsosPositivos + r.falsosNegativos})`);
    if (!melhorDiferenca || r.taxaAcerto > melhorDiferenca.taxaAcerto) melhorDiferenca = { limiar, ...r };
  }

  console.log(`\n  Melhor limiar de diferença encontrado: ${melhorDiferenca.limiar.toFixed(1)} → ${melhorDiferenca.taxaAcerto.toFixed(1)}% de acerto`);
  console.log(`  ${melhorDiferenca.taxaAcerto > taxaBaseMarcou ? '✅ SUPERA' : '❌ NÃO supera'} a linha de base (${taxaBaseMarcou.toFixed(1)}%)`);

  console.log('\n=== Resumo (taxa de acerto geral) ===');
  console.log(`Linha de base (sempre prevê que marca): ${taxaBaseMarcou.toFixed(1)}%`);
  console.log(`Melhor com razão (X/Y): ${melhorRazao.taxaAcerto.toFixed(1)}% (limiar ${melhorRazao.limiar})`);
  console.log(`Melhor com diferença (X-Y): ${melhorDiferenca.taxaAcerto.toFixed(1)}% (limiar ${melhorDiferenca.limiar})`);

  // ---------- Foco no caso raro: identificar quando o time NÃO vai marcar ----------
  console.log('\n\n=== FOCO: identificar especificamente os jogos onde o time NÃO marca ===');
  const taxaBaseNaoMarcou = 100 - taxaBaseMarcou;
  console.log(`Se a regra fosse aleatória, a precisão esperada seria perto de ${taxaBaseNaoMarcou.toFixed(1)}% (a proporção real de "não marcou" na amostra).`);
  console.log(`O teste de verdade: algum limiar consegue precisão BEM ACIMA disso?\n`);

  console.log('Limiar (razão) | Previu "não marca" em quantos jogos | Precisão | Cobertura (recall)');
  for (const limiar of candidatosRazao) {
    const r = avaliarLimiar(fatoresRazao, resultadosReais, limiar);
    const previuNaoMarca = r.verdadeirosNegativos + r.falsosNegativos; // fator <= limiar
    const precisao = previuNaoMarca > 0 ? (r.verdadeirosNegativos / previuNaoMarca) * 100 : 0;
    const totalNaoMarcaramDeVerdade = resultadosReais.filter((x) => !x).length;
    const cobertura = (r.verdadeirosNegativos / totalNaoMarcaramDeVerdade) * 100;

    const destaque = precisao > taxaBaseNaoMarcou + 5 ? ' ⭐' : '';
    console.log(`  ${limiar.toFixed(1)}           | ${previuNaoMarca}                                   | ${precisao.toFixed(1)}%    | ${cobertura.toFixed(1)}%${destaque}`);
  }
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
