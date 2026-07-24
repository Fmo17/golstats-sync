/**
 * regressao-logistica.js
 *
 * Implementa a ideia de "pesos que se ajustam conforme a correlação real dos
 * dados" -- isso é, tecnicamente, uma REGRESSÃO LOGÍSTICA MULTINOMIAL (também
 * chamada de "softmax regression"). Cada variável (diferença de gols esperada,
 * forma recente, saldo de gols geral) recebe um peso que é CALCULADO
 * matematicamente a partir dos jogos já aconteceram -- não somos nós que
 * decidimos o peso, o algoritmo de treinamento (gradiente descendente) que
 * encontra os pesos que melhor explicam os resultados reais.
 *
 * IMPORTANTE (expectativa honesta): como o modelo de Poisson mais simples já
 * mostrou estar limitado por volume de dado, é esperado que adicionar mais
 * variáveis piore ainda mais essa limitação (mais parâmetros = precisa de
 * mais dado pra estimar cada um com confiança). Estamos testando pra medir
 * isso de verdade, não assumindo.
 *
 * Diferença metodológica importante: por limitação de tempo de processamento,
 * esse teste usa um único corte treino/teste (70% mais antigo pra treinar,
 * 30% mais recente pra testar) -- diferente do backtest "walk-forward" que
 * fizemos com o modelo de Poisson (que re-calculava a cada partida). Ainda
 * assim, o teste NUNCA usa dado do futuro em relação ao que está prevendo.
 *
 * Uso:
 *   node scripts/regressao-logistica.js --competicao=71
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

// ---------- Reaproveitando o motor de gols esperados (mesma lógica do Poisson) ----------

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

function calcularForcaTime(partidas, timeId, dataReferencia, mediaGolsCasaLiga, mediaGolsForaLiga, janela = 20) {
  const jogosCasa = partidas.filter((p) => p.time_casa_id === timeId).slice(0, janela);
  const jogosFora = partidas.filter((p) => p.time_fora_id === timeId).slice(0, janela);

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

// ---------- Construção das variáveis (features) ----------

/**
 * Pra cada partida, monta um vetor de variáveis usando SOMENTE dado anterior
 * àquele jogo (sem olhar o futuro):
 *  1. Diferença de gols esperados (a mesma conta do modelo de Poisson, resumida em 1 número)
 *  2. Forma recente do time da casa (taxa de vitória nos últimos 5 jogos em casa)
 *  3. Forma recente do time de fora (taxa de vitória nos últimos 5 jogos fora)
 *  4. Saldo de gols geral do time da casa (últimos 10 jogos, qualquer mando)
 *  5. Saldo de gols geral do time de fora (últimos 10 jogos, qualquer mando)
 */
function construirVariaveis(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLiga(partidasAnteriores, dataReferencia);
  const forcaCasa = calcularForcaTime(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const forcaFora = calcularForcaTime(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);

  if (forcaCasa.totalJogos < 6 || forcaFora.totalJogos < 6) return null;

  const golsEsperadosCasa = mediaGolsCasa * forcaCasa.ataqueCasa * forcaFora.defesaFora;
  const golsEsperadosFora = mediaGolsFora * forcaFora.ataqueFora * forcaCasa.defesaCasa;
  const diffGolsEsperados = golsEsperadosCasa - golsEsperadosFora;

  function formaRecente(partidas, timeId, mandante) {
    const jogos = partidas
      .filter((p) => (mandante ? p.time_casa_id === timeId : p.time_fora_id === timeId))
      .slice(0, 5);
    if (jogos.length === 0) return 0.5; // neutro
    const vitorias = jogos.filter((j) =>
      mandante ? j.gols_casa > j.gols_fora : j.gols_fora > j.gols_casa
    ).length;
    return vitorias / jogos.length;
  }

  function saldoGolsGeral(partidas, timeId) {
    const jogos = partidas
      .filter((p) => p.time_casa_id === timeId || p.time_fora_id === timeId)
      .slice(0, 10);
    if (jogos.length === 0) return 0;
    let saldo = 0;
    for (const j of jogos) {
      if (j.time_casa_id === timeId) saldo += j.gols_casa - j.gols_fora;
      else saldo += j.gols_fora - j.gols_casa;
    }
    return saldo / jogos.length;
  }

  return [
    diffGolsEsperados,
    formaRecente(partidasAnteriores, timeCasaId, true),
    formaRecente(partidasAnteriores, timeForaId, false),
    saldoGolsGeral(partidasAnteriores, timeCasaId),
    saldoGolsGeral(partidasAnteriores, timeForaId),
  ];
}

// ---------- Regressão logística multinomial (softmax), treinada do zero ----------

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

/**
 * Treina regressão logística multinomial via gradiente descendente (full-batch).
 * Y é um array de classes: 0 = casa, 1 = empate, 2 = fora.
 * Inclui regularização L2 (penaliza pesos grandes) -- importante justamente
 * porque temos pouco dado, isso ajuda a evitar que o modelo "decore" ruído.
 */
function treinarSoftmax(X, Y, numClasses = 3, taxaAprendizado = 0.1, epocas = 3000, l2 = 0.05) {
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
        const reg = l2 * W[i][k];
        W[i][k] -= taxaAprendizado * (gradW[i][k] / n + reg);
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

// ---------- Fluxo principal ----------

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

  // Monta o dataset de variáveis (pulando o "aquecimento" inicial, igual no backtest do Poisson)
  const inicioValido = Math.floor(todasPartidas.length * 0.3);
  const X = [];
  const Y = [];
  const partidasUsadas = [];

  for (let i = inicioValido; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);
    const vars = construirVariaveis(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
    if (!vars) continue;

    let classe;
    if (partida.gols_casa > partida.gols_fora) classe = 0;
    else if (partida.gols_casa === partida.gols_fora) classe = 1;
    else classe = 2;

    X.push(vars);
    Y.push(classe);
    partidasUsadas.push(partida);
  }

  console.log(`${X.length} partidas com variáveis completas.`);

  // Corte treino (70% mais antigo) / teste (30% mais recente) -- cronológico, sem embaralhar
  const corte = Math.floor(X.length * 0.7);
  const Xtreino = X.slice(0, corte);
  const Ytreino = Y.slice(0, corte);
  const Xteste = X.slice(corte);
  const Yteste = Y.slice(corte);
  const partidasTeste = partidasUsadas.slice(corte);

  console.log(`Treino: ${Xtreino.length} partidas | Teste: ${Xteste.length} partidas\n`);

  const { Xnorm: XtreinoNorm, medias, desvios } = normalizarFeatures(Xtreino);
  const XtesteNorm = Xteste.map((x) => x.map((v, i) => (v - medias[i]) / desvios[i]));

  console.log('Treinando regressão logística (gradiente descendente)...');
  const { W, b } = treinarSoftmax(XtreinoNorm, Ytreino);

  console.log('\nPesos aprendidos (quanto maior o valor absoluto, mais peso essa variável tem):');
  const nomesVariaveis = ['Diferença de gols esperados', 'Forma recente casa', 'Forma recente fora', 'Saldo de gols geral casa', 'Saldo de gols geral fora'];
  nomesVariaveis.forEach((nome, i) => {
    console.log(`  ${nome}: casa=${W[i][0].toFixed(3)}, empate=${W[i][1].toFixed(3)}, fora=${W[i][2].toFixed(3)}`);
  });

  // Avaliação no conjunto de teste
  let acertos = 0;
  let acertosBase = 0;
  let somaBrier = 0;

  for (let i = 0; i < XtesteNorm.length; i++) {
    const p = prever(XtesteNorm[i], W, b);
    const previsto = p.indexOf(Math.max(...p));
    if (previsto === Yteste[i]) acertos++;
    if (Yteste[i] === 0) acertosBase++; // classe 0 = casa venceu

    const real01 = Yteste[i] === 0 ? 1 : 0;
    somaBrier += Math.pow(p[0] - real01, 2);
  }

  const taxaAcerto = (acertos / Xteste.length) * 100;
  const taxaBase = (acertosBase / Xteste.length) * 100;
  const brier = somaBrier / Xteste.length;

  console.log('\n=== Resultado no conjunto de teste (30% mais recente, nunca visto no treino) ===');
  console.log(`Taxa de acerto da regressão logística: ${taxaAcerto.toFixed(1)}%`);
  console.log(`Linha de base ("sempre casa") nesse mesmo recorte: ${taxaBase.toFixed(1)}%`);
  console.log(`${taxaAcerto > taxaBase ? '✅ Modelo SUPERA a linha de base' : '❌ Modelo NÃO supera a linha de base'}`);
  console.log(`Brier score: ${brier.toFixed(3)}`);
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
