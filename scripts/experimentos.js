/**
 * experimentos.js
 *
 * Testa VÁRIAS configurações do modelo de uma vez (grid de parâmetros) e
 * mostra um ranking de qual combinação teve mais vantagem real sobre a
 * linha de base ("sempre aposta em casa").
 *
 * Roda contra uma única competição por vez (a mais confiável, com mais
 * amostra), pra manter o tempo de execução viável.
 *
 * Uso:
 *   node scripts/experimentos.js --competicao=71
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
const MAX_GOLS = 8;

// ---------- Funções matemáticas base (parametrizadas) ----------

function fatorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poisson(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fatorial(k);
}

function pesoDecaimento(diasAtras, meiaVidaDias) {
  return Math.pow(0.5, diasAtras / meiaVidaDias);
}

function ajusteDixonColes(gc, gf, lambdaCasa, lambdaFora, rho) {
  if (gc === 0 && gf === 0) return 1 - lambdaCasa * lambdaFora * rho;
  if (gc === 0 && gf === 1) return 1 + lambdaCasa * rho;
  if (gc === 1 && gf === 0) return 1 + lambdaFora * rho;
  if (gc === 1 && gf === 1) return 1 - rho;
  return 1;
}

function preverPartida(golsEsperadosCasa, golsEsperadosFora, usarDixonColes, rho) {
  const matriz = [];
  let somaBruta = 0;

  for (let gc = 0; gc <= MAX_GOLS; gc++) {
    matriz[gc] = [];
    for (let gf = 0; gf <= MAX_GOLS; gf++) {
      const base = poisson(gc, golsEsperadosCasa) * poisson(gf, golsEsperadosFora);
      const ajuste = usarDixonColes ? ajusteDixonColes(gc, gf, golsEsperadosCasa, golsEsperadosFora, rho) : 1;
      matriz[gc][gf] = base * ajuste;
      somaBruta += matriz[gc][gf];
    }
  }

  for (let gc = 0; gc <= MAX_GOLS; gc++) {
    for (let gf = 0; gf <= MAX_GOLS; gf++) matriz[gc][gf] /= somaBruta;
  }

  let probVitoriaCasa = 0, probEmpate = 0, probVitoriaFora = 0;
  for (let gc = 0; gc <= MAX_GOLS; gc++) {
    for (let gf = 0; gf <= MAX_GOLS; gf++) {
      const p = matriz[gc][gf];
      if (gc > gf) probVitoriaCasa += p;
      else if (gc === gf) probEmpate += p;
      else probVitoriaFora += p;
    }
  }

  return { probVitoriaCasa, probEmpate, probVitoriaFora };
}

function calcularMediasLiga(partidas, dataReferencia, meiaVidaDias) {
  let somaGolsCasa = 0, somaGolsFora = 0, somaPesos = 0;
  for (const p of partidas) {
    const dias = (new Date(dataReferencia) - new Date(p.data_hora)) / 86400000;
    const peso = pesoDecaimento(dias, meiaVidaDias);
    somaGolsCasa += p.gols_casa * peso;
    somaGolsFora += p.gols_fora * peso;
    somaPesos += peso;
  }
  if (somaPesos === 0) return { mediaGolsCasa: 1.3, mediaGolsFora: 1.1 };
  return { mediaGolsCasa: somaGolsCasa / somaPesos, mediaGolsFora: somaGolsFora / somaPesos };
}

function calcularForcaTime(partidas, timeId, dataReferencia, mediaGolsCasaLiga, mediaGolsForaLiga, janelaJogos, meiaVidaDias) {
  const jogosCasa = partidas.filter((p) => p.time_casa_id === timeId).slice(0, janelaJogos);
  const jogosFora = partidas.filter((p) => p.time_fora_id === timeId).slice(0, janelaJogos);

  function mediaComPeso(jogos, campoPro, campoContra) {
    let somaPro = 0, somaContra = 0, somaPesos = 0;
    for (const j of jogos) {
      const dias = (new Date(dataReferencia) - new Date(j.data_hora)) / 86400000;
      const peso = pesoDecaimento(dias, meiaVidaDias);
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

function preverConfrontoSimples(partidasAnteriores, timeCasaId, timeForaId, dataReferencia, config) {
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLiga(partidasAnteriores, dataReferencia, config.meiaVidaDias);
  const forcaCasa = calcularForcaTime(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora, config.janelaJogos, config.meiaVidaDias);
  const forcaFora = calcularForcaTime(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora, config.janelaJogos, config.meiaVidaDias);

  if (forcaCasa.totalJogos < config.minimoJogos || forcaFora.totalJogos < config.minimoJogos) return null;

  const golsEsperadosCasa = mediaGolsCasa * forcaCasa.ataqueCasa * forcaFora.defesaFora;
  const golsEsperadosFora = mediaGolsFora * forcaFora.ataqueFora * forcaCasa.defesaCasa;

  return preverPartida(golsEsperadosCasa, golsEsperadosFora, config.usarDixonColes, config.rho);
}

// ---------- Backtest de uma configuração ----------

async function testarConfiguracao(todasPartidas, config) {
  const inicioTeste = Math.floor(todasPartidas.length * 0.3);
  let previsoes = 0, acertos = 0, acertosBase = 0, somaBrier = 0;

  for (let i = inicioTeste; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    const previsao = preverConfrontoSimples(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora, config);
    if (!previsao) continue;

    previsoes++;

    let real;
    if (partida.gols_casa > partida.gols_fora) real = 'casa';
    else if (partida.gols_casa === partida.gols_fora) real = 'empate';
    else real = 'fora';

    const probs = { casa: previsao.probVitoriaCasa, empate: previsao.probEmpate, fora: previsao.probVitoriaFora };
    const previsto = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];

    if (previsto === real) acertos++;
    if (real === 'casa') acertosBase++;

    const real01 = real === 'casa' ? 1 : 0;
    somaBrier += Math.pow(previsao.probVitoriaCasa - real01, 2);
  }

  if (previsoes === 0) return null;

  return {
    previsoes,
    taxaAcerto: (acertos / previsoes) * 100,
    taxaBase: (acertosBase / previsoes) * 100,
    brier: somaBrier / previsoes,
  };
}

// ---------- Fluxo principal ----------

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71; // default Série A

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

  // ---------- Configurações a testar ----------
  const base = { janelaJogos: 20, meiaVidaDias: 60, usarDixonColes: true, rho: -0.13, minimoJogos: 6 };

  const configuracoes = [
    { nome: 'Base (janela=20, meia-vida=60, com Dixon-Coles)', ...base },
    { nome: 'Janela menor (10 jogos)', ...base, janelaJogos: 10 },
    { nome: 'Janela menor (15 jogos)', ...base, janelaJogos: 15 },
    { nome: 'Janela maior (25 jogos)', ...base, janelaJogos: 25 },
    { nome: 'Janela maior (30 jogos)', ...base, janelaJogos: 30 },
    { nome: 'Decaimento mais rápido (meia-vida=30 dias)', ...base, meiaVidaDias: 30 },
    { nome: 'Decaimento mais lento (meia-vida=90 dias)', ...base, meiaVidaDias: 90 },
    { nome: 'Decaimento bem mais lento (meia-vida=180 dias)', ...base, meiaVidaDias: 180 },
    { nome: 'Sem Dixon-Coles (Poisson puro)', ...base, usarDixonColes: false },
    { nome: 'Dixon-Coles mais forte (rho=-0.20)', ...base, rho: -0.2 },
    { nome: 'Exige mais jogos mínimos (10)', ...base, minimoJogos: 10 },
  ];

  const resultados = [];
  for (const config of configuracoes) {
    process.stdout.write(`Testando: ${config.nome}... `);
    const r = await testarConfiguracao(todasPartidas, config);
    if (r) {
      const vantagem = r.taxaAcerto - r.taxaBase;
      resultados.push({ ...config, ...r, vantagem });
      console.log(`${r.taxaAcerto.toFixed(1)}% (base ${r.taxaBase.toFixed(1)}%, vantagem ${vantagem >= 0 ? '+' : ''}${vantagem.toFixed(1)}pp, Brier ${r.brier.toFixed(3)})`);
    } else {
      console.log('sem previsões suficientes.');
    }
  }

  resultados.sort((a, b) => b.vantagem - a.vantagem);

  console.log('\n=== RANKING (melhor vantagem sobre a linha de base primeiro) ===\n');
  resultados.forEach((r, i) => {
    const status = r.vantagem > 0 ? '✅' : '❌';
    console.log(`${i + 1}. ${status} ${r.nome}`);
    console.log(`   Acerto: ${r.taxaAcerto.toFixed(1)}% | Base: ${r.taxaBase.toFixed(1)}% | Vantagem: ${r.vantagem >= 0 ? '+' : ''}${r.vantagem.toFixed(1)}pp | Brier: ${r.brier.toFixed(3)} | Previsões: ${r.previsoes}`);
  });

  console.log('\n=== Melhor configuração encontrada ===');
  const melhor = resultados[0];
  console.log(`${melhor.nome}`);
  console.log(`janelaJogos=${melhor.janelaJogos}, meiaVidaDias=${melhor.meiaVidaDias}, usarDixonColes=${melhor.usarDixonColes}, rho=${melhor.rho}, minimoJogos=${melhor.minimoJogos}`);
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
