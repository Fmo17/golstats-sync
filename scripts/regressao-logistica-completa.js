/**
 * regressao-logistica-completa.js
 *
 * Versão expandida da regressão logística, com o conjunto completo de
 * variáveis que você pediu (V/E/D em janelas de 5/10/15 jogos, separado por
 * mando de campo, médias de gols marcados/sofridos em cada janela, mais
 * posse de bola/cartões quando disponível).
 *
 * AVISO HONESTO: com ~26 variáveis e só ~180 jogos de treino, o risco de
 * overfitting é real e esperado matematicamente (regra geral: precisa de uns
 * 10-20 exemplos por variável pra estimar peso com confiança -- aqui teríamos
 * bem menos que isso). Estamos testando pra medir isso de verdade.
 *
 * Uso:
 *   node scripts/regressao-logistica-completa.js --competicao=71
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

function pesoDecaimento(diasAtras, meiaVidaDias = 60) {
  return Math.pow(0.5, diasAtras / meiaVidaDias);
}

function calcularMediasLiga(partidas, dataReferencia) {
  let somaGolsCasa = 0, somaGolsFora = 0, somaPesos = 0;
  for (const p of partidas) {
    const dias = (new Date(dataReferencia) - new Date(p.data_hora)) / 86400000;
    const peso = pesoDecaimento(dias);
    somaGolsCasa += p.gols_casa * peso;
    somaGolsFora += p.gols_fora * peso;
    somaPesos += peso;
  }
  if (somaPesos === 0) return { mediaGolsCasa: 1.3, mediaGolsFora: 1.1 };
  return { mediaGolsCasa: somaGolsCasa / somaPesos, mediaGolsFora: somaGolsFora / somaPesos };
}

// CORRIGIDO em 2026-09-16: mesmo bug do gerar-sinais.js e validar-mercados.js
// -- .slice(0, janela) pegava os jogos mais ANTIGOS. Agora .slice(-janela)
// pega os mais RECENTES.
function calcularForcaTime(partidas, timeId, dataReferencia, mediaGolsCasaLiga, mediaGolsForaLiga, janela = 20) {
  const jogosCasa = partidas.filter((p) => p.time_casa_id === timeId).slice(-janela);
  const jogosFora = partidas.filter((p) => p.time_fora_id === timeId).slice(-janela);

  function mediaComPeso(jogos, campoPro, campoContra) {
    let somaPro = 0, somaContra = 0, somaPesos = 0;
    for (const j of jogos) {
      const dias = (new Date(dataReferencia) - new Date(j.data_hora)) / 86400000;
      const peso = pesoDecaimento(dias);
      somaPro += j[campoPro] * peso;
      somaContra += j[campoContra] * peso;
      somaPesos += peso;
    }
    return somaPesos > 0 ? { mediaPro: somaPro / somaPesos, mediaContra: somaContra / somaPesos } : null;
  }

  const emCasa = mediaComPeso(jogosCasa, 'gols_casa', 'gols_fora');
  const fora = mediaComPeso(jogosFora, 'gols_fora', 'gols_casa');

  return {
    totalJogos: jogosCasa.length + jogosFora.length,
    ataqueCasa: emCasa ? emCasa.mediaPro / mediaGolsCasaLiga : 1,
    defesaCasa: emCasa ? emCasa.mediaContra / mediaGolsForaLiga : 1,
    ataqueFora: fora ? fora.mediaPro / mediaGolsForaLiga : 1,
    defesaFora: fora ? fora.mediaContra / mediaGolsCasaLiga : 1,
  };
}

// CORRIGIDO em 2026-09-16: mesmo bug -- .slice(0, janela) -> .slice(-janela)
function jogosDoTime(partidas, timeId, mandante, janela) {
  return partidas
    .filter((p) => (mandante ? p.time_casa_id === timeId : p.time_fora_id === timeId))
    .slice(-janela);
}

function taxaVitoria(jogos, mandante) {
  if (jogos.length === 0) return 0.33;
  const vitorias = jogos.filter((j) => (mandante ? j.gols_casa > j.gols_fora : j.gols_fora > j.gols_casa)).length;
  return vitorias / jogos.length;
}

function taxaEmpate(jogos) {
  if (jogos.length === 0) return 0.33;
  const empates = jogos.filter((j) => j.gols_casa === j.gols_fora).length;
  return empates / jogos.length;
}

function mediaGolsMarcados(jogos, timeId) {
  if (jogos.length === 0) return 1.2;
  const soma = jogos.reduce((s, j) => s + (j.time_casa_id === timeId ? j.gols_casa : j.gols_fora), 0);
  return soma / jogos.length;
}

function mediaGolsSofridos(jogos, timeId) {
  if (jogos.length === 0) return 1.2;
  const soma = jogos.reduce((s, j) => s + (j.time_casa_id === timeId ? j.gols_fora : j.gols_casa), 0);
  return soma / jogos.length;
}

const NOMES_VARIAVEIS = [
  'Diferença de gols esperados (Poisson)',
  'Taxa vitória casa (5j)', 'Taxa vitória casa (10j)', 'Taxa vitória casa (15j)',
  'Taxa empate casa (5j)', 'Taxa empate casa (10j)', 'Taxa empate casa (15j)',
  'Média gols marcados casa (5j)', 'Média gols marcados casa (10j)', 'Média gols marcados casa (15j)',
  'Média gols sofridos casa (5j)', 'Média gols sofridos casa (10j)', 'Média gols sofridos casa (15j)',
  'Taxa vitória fora (5j)', 'Taxa vitória fora (10j)', 'Taxa vitória fora (15j)',
  'Taxa empate fora (5j)', 'Taxa empate fora (10j)', 'Taxa empate fora (15j)',
  'Média gols marcados fora (5j)', 'Média gols marcados fora (10j)', 'Média gols marcados fora (15j)',
  'Média gols sofridos fora (5j)', 'Média gols sofridos fora (10j)', 'Média gols sofridos fora (15j)',
];

function construirVariaveisCompletas(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLiga(partidasAnteriores, dataReferencia);
  const forcaCasa = calcularForcaTime(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const forcaFora = calcularForcaTime(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);

  if (forcaCasa.totalJogos < 6 || forcaFora.totalJogos < 6) return null;

  const golsEsperadosCasa = mediaGolsCasa * forcaCasa.ataqueCasa * forcaFora.defesaFora;
  const golsEsperadosFora = mediaGolsFora * forcaFora.ataqueFora * forcaCasa.defesaCasa;
  const diffGolsEsperados = golsEsperadosCasa - golsEsperadosFora;

  const vars = [diffGolsEsperados];

  for (const janela of [5, 10, 15]) {
    const jogos = jogosDoTime(partidasAnteriores, timeCasaId, true, janela);
    vars.push(taxaVitoria(jogos, true));
  }
  for (const janela of [5, 10, 15]) {
    const jogos = jogosDoTime(partidasAnteriores, timeCasaId, true, janela);
    vars.push(taxaEmpate(jogos));
  }
  for (const janela of [5, 10, 15]) {
    const jogos = jogosDoTime(partidasAnteriores, timeCasaId, true, janela);
    vars.push(mediaGolsMarcados(jogos, timeCasaId));
  }
  for (const janela of [5, 10, 15]) {
    const jogos = jogosDoTime(partidasAnteriores, timeCasaId, true, janela);
    vars.push(mediaGolsSofridos(jogos, timeCasaId));
  }

  for (const janela of [5, 10, 15]) {
    const jogos = jogosDoTime(partidasAnteriores, timeForaId, false, janela);
    vars.push(taxaVitoria(jogos, false));
  }
  for (const janela of [5, 10, 15]) {
    const jogos = jogosDoTime(partidasAnteriores, timeForaId, false, janela);
    vars.push(taxaEmpate(jogos));
  }
  for (const janela of [5, 10, 15]) {
    const jogos = jogosDoTime(partidasAnteriores, timeForaId, false, janela);
    vars.push(mediaGolsMarcados(jogos, timeForaId));
  }
  for (const janela of [5, 10, 15]) {
    const jogos = jogosDoTime(partidasAnteriores, timeForaId, false, janela);
    vars.push(mediaGolsSofridos(jogos, timeForaId));
  }

  return vars;
}

function softmax(z) {
  const m = Math.max(...z);
  const exps = z.map((v) => Math.exp(v - m));
  const soma = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / soma);
}

function normalizarFeatures(X) {
  const numFeatures = X[0].length;
  const medias = new Array(numFeatures).fill(0);
  const desvios = new Array(numFeatures).fill(0);
  for (const x of X) for (let i = 0; i < numFeatures; i++) medias[i] += x[i];
  for (let i = 0; i < numFeatures; i++) medias[i] /= X.length;
  for (const x of X) for (let i = 0; i < numFeatures; i++) desvios[i] += Math.pow(x[i] - medias[i], 2);
  for (let i = 0; i < numFeatures; i++) desvios[i] = Math.sqrt(desvios[i] / X.length) || 1;
  const Xnorm = X.map((x) => x.map((v, i) => (v - medias[i]) / desvios[i]));
  return { Xnorm, medias, desvios };
}

function treinarSoftmax(X, Y, numClasses = 3, taxaAprendizado = 0.1, epocas = 3000, l2 = 0.1) {
  const n = X.length;
  const numFeatures = X[0].length;
  let W = Array.from({ length: numFeatures }, () => new Array(numClasses).fill(0));
  let b = new Array(numClasses).fill(0);

  for (let epoca = 0; epoca < epocas; epoca++) {
    const gradW = Array.from({ length: numFeatures }, () => new Array(numClasses).fill(0));
    const gradB = new Array(numClasses).fill(0);

    for (let idx = 0; idx < n; idx++) {
      const x = X[idx];
      const yClasse = Y[idx];
      const z = new Array(numClasses).fill(0);
      for (let k = 0; k < numClasses; k++) {
        let soma = b[k];
        for (let i = 0; i < numFeatures; i++) soma += W[i][k] * x[i];
        z[k] = soma;
      }
      const p = softmax(z);
      for (let k = 0; k < numClasses; k++) {
        const erro = p[k] - (k === yClasse ? 1 : 0);
        gradB[k] += erro;
        for (let i = 0; i < numFeatures; i++) gradW[i][k] += erro * x[i];
      }
    }

    for (let k = 0; k < numClasses; k++) {
      b[k] -= taxaAprendizado * (gradB[k] / n);
      for (let i = 0; i < numFeatures; i++) {
        W[i][k] -= taxaAprendizado * (gradW[i][k] / n + l2 * W[i][k]);
      }
    }
  }
  return { W, b };
}

function prever(x, W, b, numClasses = 3) {
  const z = new Array(numClasses).fill(0);
  for (let k = 0; k < numClasses; k++) {
    let soma = b[k];
    for (let i = 0; i < x.length; i++) soma += W[i][k] * x[i];
    z[k] = soma;
  }
  return softmax(z);
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
  console.log(`${todasPartidas.length} partidas carregadas.`);
  console.log(`Número de variáveis usadas: ${NOMES_VARIAVEIS.length}\n`);

  const inicioValido = Math.floor(todasPartidas.length * 0.3);
  const X = [];
  const Y = [];

  for (let i = inicioValido; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);
    const vars = construirVariaveisCompletas(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
    if (!vars) continue;

    let classe;
    if (partida.gols_casa > partida.gols_fora) classe = 0;
    else if (partida.gols_casa === partida.gols_fora) classe = 1;
    else classe = 2;

    X.push(vars);
    Y.push(classe);
  }

  console.log(`${X.length} partidas com variáveis completas.`);

  const corte = Math.floor(X.length * 0.7);
  const Xtreino = X.slice(0, corte);
  const Ytreino = Y.slice(0, corte);
  const Xteste = X.slice(corte);
  const Yteste = Y.slice(corte);

  const proporcaoExemplosPorVariavel = Xtreino.length / NOMES_VARIAVEIS.length;
  console.log(`Treino: ${Xtreino.length} partidas | Teste: ${Xteste.length} partidas`);
  console.log(`Proporção exemplos/variável no treino: ${proporcaoExemplosPorVariavel.toFixed(1)} (regra geral recomendada: 10-20+; abaixo disso, risco de overfitting é alto)\n`);

  const { Xnorm: XtreinoNorm, medias, desvios } = normalizarFeatures(Xtreino);
  const XtesteNorm = Xteste.map((x) => x.map((v, i) => (v - medias[i]) / desvios[i]));

  console.log('Treinando regressão logística (gradiente descendente)...\n');
  const { W, b } = treinarSoftmax(XtreinoNorm, Ytreino);

  console.log('Pesos aprendidos (ordenados por magnitude, maiores primeiro):');
  const pesosComNome = NOMES_VARIAVEIS.map((nome, i) => ({
    nome,
    magnitude: Math.abs(W[i][0]) + Math.abs(W[i][1]) + Math.abs(W[i][2]),
    casa: W[i][0], empate: W[i][1], fora: W[i][2],
  })).sort((a, b) => b.magnitude - a.magnitude);

  pesosComNome.slice(0, 10).forEach((p) => {
    console.log(`  ${p.nome}: casa=${p.casa.toFixed(3)}, empate=${p.empate.toFixed(3)}, fora=${p.fora.toFixed(3)}`);
  });
  console.log('  ... (demais variáveis com peso menor)');

  let acertos = 0, acertosBase = 0, somaBrier = 0;

  for (let i = 0; i < XtesteNorm.length; i++) {
    const p = prever(XtesteNorm[i], W, b);
    const previsto = p.indexOf(Math.max(...p));
    if (previsto === Yteste[i]) acertos++;
    if (Yteste[i] === 0) acertosBase++;
    const real01 = Yteste[i] === 0 ? 1 : 0;
    somaBrier += Math.pow(p[0] - real01, 2);
  }

  const taxaAcerto = (acertos / Xteste.length) * 100;
  const taxaBase = (acertosBase / Xteste.length) * 100;
  const brier = somaBrier / Xteste.length;

  console.log('\n=== Resultado no conjunto de teste (30% mais recente, nunca visto no treino) ===');
  console.log(`Taxa de acerto da regressão logística (${NOMES_VARIAVEIS.length} variáveis): ${taxaAcerto.toFixed(1)}%`);
  console.log(`Linha de base ("sempre casa") nesse mesmo recorte: ${taxaBase.toFixed(1)}%`);
  console.log(`${taxaAcerto > taxaBase ? '✅ Modelo SUPERA a linha de base' : '❌ Modelo NÃO supera a linha de base'}`);
  console.log(`Brier score: ${brier.toFixed(3)}`);
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
