/**
 * calcular-sinais.js
 *
 * Motor de probabilidade estatística (modelo de Poisson + Dixon-Coles) para
 * partidas de futebol -- versão consolidada após a rodada de experimentos.
 *
 * HISTÓRICO DE DECISÕES (pra não perder o porquê depois):
 * - Testamos calcular a força do time olhando pra TODAS as competições que
 *   ele disputou (cross-competição, normalizando por dificuldade). Resultado:
 *   piorou o desempenho (times rotacionam elenco em competições menos
 *   importantes, o que "suja" a estimativa mesmo com a normalização por
 *   gols). Reprovado, não usamos mais essa abordagem.
 * - Testamos várias janelas/decaimentos via scripts/experimentos.js. A
 *   configuração "janela=25 jogos" foi a que teve melhor resultado (com 3
 *   temporadas de dado -- 2022/2023/2024, único plano Free): +0.6pp sobre a
 *   linha de base, Brier score 0.242 (melhor calibração vista até aqui).
 * - Testamos regressão logística com várias variáveis -- com pouco dado,
 *   fez overfitting feio (piorou). Com 3 temporadas, parou de piorar mas
 *   ainda não supera o Poisson. Não é a abordagem principal por enquanto.
 *
 * Uso:
 *   node scripts/calcular-sinais.js --backtest --competicao=71
 *   node scripts/calcular-sinais.js --backtest
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

// ---------- Parâmetros do modelo (calibrados via scripts/experimentos.js) ----------
const JANELA_JOGOS = 25;
const MEIA_VIDA_DIAS = 60;
const MAX_GOLS = 8;
const MINIMO_JOGOS_PARA_PREVER = 6;
const RHO_DIXON_COLES = -0.13;

// ---------- Funções matemáticas base ----------

function fatorial(n) {
  let resultado = 1;
  for (let i = 2; i <= n; i++) resultado *= i;
  return resultado;
}

function poisson(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fatorial(k);
}

function pesoDecaimento(diasAtras) {
  return Math.pow(0.5, diasAtras / MEIA_VIDA_DIAS);
}

function ajusteDixonColes(golsCasa, golsFora, lambdaCasa, lambdaFora, rho) {
  if (golsCasa === 0 && golsFora === 0) return 1 - lambdaCasa * lambdaFora * rho;
  if (golsCasa === 0 && golsFora === 1) return 1 + lambdaCasa * rho;
  if (golsCasa === 1 && golsFora === 0) return 1 + lambdaFora * rho;
  if (golsCasa === 1 && golsFora === 1) return 1 - rho;
  return 1;
}

// ---------- Busca de dados (SÓ dentro da mesma competição -- validado como melhor) ----------

async function buscarPartidasAnteriores(competicaoId, dataReferencia, limite = 1500) {
  const { data, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', competicaoId)
    .eq('status', 'finalizado')
    .lt('data_hora', dataReferencia)
    .not('gols_casa', 'is', null)
    .order('data_hora', { ascending: false })
    .limit(limite);

  if (error) throw error;
  return data || [];
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

function calcularForcaTime(partidas, timeId, dataReferencia, mediaGolsCasaLiga, mediaGolsForaLiga) {
  const jogosCasa = partidas.filter((p) => p.time_casa_id === timeId).slice(0, JANELA_JOGOS);
  const jogosFora = partidas.filter((p) => p.time_fora_id === timeId).slice(0, JANELA_JOGOS);

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
  const totalJogos = jogosCasa.length + jogosFora.length;

  return {
    totalJogos,
    ataqueCasa: emCasa ? emCasa.mediaPro / mediaGolsCasaLiga : 1,
    defesaCasa: emCasa ? emCasa.mediaContra / mediaGolsForaLiga : 1,
    ataqueFora: fora ? fora.mediaPro / mediaGolsForaLiga : 1,
    defesaFora: fora ? fora.mediaContra / mediaGolsCasaLiga : 1,
  };
}

// ---------- Núcleo do modelo ----------

function preverPartida(golsEsperadosCasa, golsEsperadosFora) {
  const matriz = [];
  let somaBruta = 0;

  for (let golsCasa = 0; golsCasa <= MAX_GOLS; golsCasa++) {
    matriz[golsCasa] = [];
    for (let golsFora = 0; golsFora <= MAX_GOLS; golsFora++) {
      const probBase = poisson(golsCasa, golsEsperadosCasa) * poisson(golsFora, golsEsperadosFora);
      const ajuste = ajusteDixonColes(golsCasa, golsFora, golsEsperadosCasa, golsEsperadosFora, RHO_DIXON_COLES);
      const valor = probBase * ajuste;
      matriz[golsCasa][golsFora] = valor;
      somaBruta += valor;
    }
  }

  for (let golsCasa = 0; golsCasa <= MAX_GOLS; golsCasa++) {
    for (let golsFora = 0; golsFora <= MAX_GOLS; golsFora++) {
      matriz[golsCasa][golsFora] /= somaBruta;
    }
  }

  let probVitoriaCasa = 0, probEmpate = 0, probVitoriaFora = 0, probOver25 = 0, probAmbasMarcam = 0;

  for (let golsCasa = 0; golsCasa <= MAX_GOLS; golsCasa++) {
    for (let golsFora = 0; golsFora <= MAX_GOLS; golsFora++) {
      const p = matriz[golsCasa][golsFora];
      if (golsCasa > golsFora) probVitoriaCasa += p;
      else if (golsCasa === golsFora) probEmpate += p;
      else probVitoriaFora += p;
      if (golsCasa + golsFora > 2.5) probOver25 += p;
      if (golsCasa >= 1 && golsFora >= 1) probAmbasMarcam += p;
    }
  }

  return {
    golsEsperadosCasa, golsEsperadosFora,
    probVitoriaCasa, probEmpate, probVitoriaFora,
    probOver25, probUnder25: 1 - probOver25, probAmbasMarcam,
  };
}

function preverConfronto(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLiga(partidasAnteriores, dataReferencia);
  const forcaCasa = calcularForcaTime(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const forcaFora = calcularForcaTime(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);

  if (forcaCasa.totalJogos < MINIMO_JOGOS_PARA_PREVER || forcaFora.totalJogos < MINIMO_JOGOS_PARA_PREVER) {
    return null;
  }

  const golsEsperadosCasa = mediaGolsCasa * forcaCasa.ataqueCasa * forcaFora.defesaFora;
  const golsEsperadosFora = mediaGolsFora * forcaFora.ataqueFora * forcaCasa.defesaCasa;

  return preverPartida(golsEsperadosCasa, golsEsperadosFora);
}

// ---------- Backtesting ----------

async function backtestCompeticao(competicaoId, nomeCompeticao) {
  console.log(`\n=== Backtesting: ${nomeCompeticao} (id ${competicaoId}) ===`);

  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', competicaoId)
    .eq('status', 'finalizado')
    .not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  if (error) throw error;

  if (!todasPartidas || todasPartidas.length < 40) {
    console.log('  Partidas insuficientes pra backtesting confiável (mínimo 40).');
    return null;
  }

  const inicioTeste = Math.floor(todasPartidas.length * 0.3);

  let previsoesFeitas = 0, acertosResultado = 0, acertosLinhaBase = 0, somaBrier = 0;

  for (let i = inicioTeste; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const partidasAnteriores = todasPartidas.slice(0, i);

    const previsao = preverConfronto(partidasAnteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
    if (!previsao) continue;

    previsoesFeitas++;

    let resultadoReal;
    if (partida.gols_casa > partida.gols_fora) resultadoReal = 'casa';
    else if (partida.gols_casa === partida.gols_fora) resultadoReal = 'empate';
    else resultadoReal = 'fora';

    const probs = { casa: previsao.probVitoriaCasa, empate: previsao.probEmpate, fora: previsao.probVitoriaFora };
    const previsto = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];

    if (previsto === resultadoReal) acertosResultado++;
    if (resultadoReal === 'casa') acertosLinhaBase++;

    const real01 = resultadoReal === 'casa' ? 1 : 0;
    somaBrier += Math.pow(previsao.probVitoriaCasa - real01, 2);
  }

  if (previsoesFeitas === 0) {
    console.log('  Não foi possível gerar previsões suficientes.');
    return null;
  }

  const taxaAcerto = (acertosResultado / previsoesFeitas) * 100;
  const taxaLinhaBase = (acertosLinhaBase / previsoesFeitas) * 100;
  const brierMedio = somaBrier / previsoesFeitas;
  const amostraPequena = previsoesFeitas < 60;

  console.log(`  Previsões testadas: ${previsoesFeitas}${amostraPequena ? '  ⚠️  AMOSTRA PEQUENA' : ''}`);
  console.log(`  Taxa de acerto do modelo (1x2): ${taxaAcerto.toFixed(1)}%`);
  console.log(`  Linha de base ingênua ("sempre aposta em casa"): ${taxaLinhaBase.toFixed(1)}%`);
  console.log(`  ${taxaAcerto > taxaLinhaBase ? '✅ Modelo SUPERA a linha de base' : '❌ Modelo NÃO supera a linha de base'}`);
  console.log(`  Brier score médio: ${brierMedio.toFixed(3)}`);

  return { competicaoId, nomeCompeticao, previsoesFeitas, taxaAcerto, taxaLinhaBase, brierMedio, amostraPequena };
}

// ---------- Fluxo principal ----------

async function main() {
  const args = process.argv.slice(2);
  const fazerBacktest = args.includes('--backtest');
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));

  if (!fazerBacktest) {
    console.log('Uso: node scripts/calcular-sinais.js --backtest [--competicao=71]');
    return;
  }

  let query = supabase.from('competicoes').select('id, nome, api_football_id').eq('ativa', true);
  if (competicaoArg) {
    query = query.eq('api_football_id', parseInt(competicaoArg.split('=')[1], 10));
  }

  const { data: competicoes, error } = await query;
  if (error) throw error;

  const resultados = [];
  for (const comp of competicoes) {
    const resultado = await backtestCompeticao(comp.id, comp.nome);
    if (resultado) resultados.push(resultado);
  }

  console.log('\n=== Resumo geral ===');
  for (const r of resultados) {
    const status = r.taxaAcerto > r.taxaLinhaBase ? '✅' : '❌';
    const aviso = r.amostraPequena ? ' [amostra pequena]' : '';
    console.log(`${status} ${r.nomeCompeticao}: modelo ${r.taxaAcerto.toFixed(1)}% vs linha de base ${r.taxaLinhaBase.toFixed(1)}% (${r.previsoesFeitas} jogos)${aviso}`);
  }
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
