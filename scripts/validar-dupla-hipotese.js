/**
 * validar-dupla-hipotese.js
 *
 * Valida FORA DA AMOSTRA o achado da dupla hipótese X2 (empate ou fora) --
 * aplica o MESMO modelo (sem reotimizar nada) em outras competições, pra ver
 * se a vantagem encontrada na Série A se sustenta ou era só a amostra.
 *
 * Uso:
 *   node scripts/validar-dupla-hipotese.js
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

const JANELA_JOGOS = 25;
const MEIA_VIDA_DIAS = 60;
const MAX_GOLS = 8;
const MINIMO_JOGOS_PARA_PREVER = 6;
const RHO_DIXON_COLES = -0.13;

function fatorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poisson(k, lambda) { return (Math.exp(-lambda) * Math.pow(lambda, k)) / fatorial(k); }
function pesoDecaimento(diasAtras) { return Math.pow(0.5, diasAtras / MEIA_VIDA_DIAS); }

function ajusteDixonColes(gc, gf, lc, lf, rho) {
  if (gc === 0 && gf === 0) return 1 - lc * lf * rho;
  if (gc === 0 && gf === 1) return 1 + lc * rho;
  if (gc === 1 && gf === 0) return 1 + lf * rho;
  if (gc === 1 && gf === 1) return 1 - rho;
  return 1;
}

function calcularMediasLiga(partidas, dataReferencia) {
  let sc = 0, sf = 0, sp = 0;
  for (const p of partidas) {
    const dias = (new Date(dataReferencia) - new Date(p.data_hora)) / 86400000;
    const peso = pesoDecaimento(dias);
    sc += p.gols_casa * peso; sf += p.gols_fora * peso; sp += peso;
  }
  if (sp === 0) return { mediaGolsCasa: 1.3, mediaGolsFora: 1.1 };
  return { mediaGolsCasa: sc / sp, mediaGolsFora: sf / sp };
}

function calcularForcaTime(partidas, timeId, dataReferencia, mgc, mgf) {
  const jc = partidas.filter((p) => p.time_casa_id === timeId).slice(0, JANELA_JOGOS);
  const jf = partidas.filter((p) => p.time_fora_id === timeId).slice(0, JANELA_JOGOS);
  function media(jogos, pro, contra) {
    let sp2 = 0, sc2 = 0, sw = 0;
    for (const j of jogos) {
      const dias = (new Date(dataReferencia) - new Date(j.data_hora)) / 86400000;
      const peso = pesoDecaimento(dias);
      sp2 += j[pro] * peso; sc2 += j[contra] * peso; sw += peso;
    }
    return sw > 0 ? { mediaPro: sp2 / sw, mediaContra: sc2 / sw } : null;
  }
  const emCasa = media(jc, 'gols_casa', 'gols_fora');
  const fora = media(jf, 'gols_fora', 'gols_casa');
  return {
    totalJogos: jc.length + jf.length,
    ataqueCasa: emCasa ? emCasa.mediaPro / mgc : 1,
    defesaCasa: emCasa ? emCasa.mediaContra / mgf : 1,
    ataqueFora: fora ? fora.mediaPro / mgf : 1,
    defesaFora: fora ? fora.mediaContra / mgc : 1,
  };
}

function preverPartida(gec, gef) {
  const matriz = [];
  let soma = 0;
  for (let gc = 0; gc <= MAX_GOLS; gc++) {
    matriz[gc] = [];
    for (let gf = 0; gf <= MAX_GOLS; gf++) {
      const base = poisson(gc, gec) * poisson(gf, gef);
      const ajuste = ajusteDixonColes(gc, gf, gec, gef, RHO_DIXON_COLES);
      matriz[gc][gf] = base * ajuste;
      soma += matriz[gc][gf];
    }
  }
  for (let gc = 0; gc <= MAX_GOLS; gc++) for (let gf = 0; gf <= MAX_GOLS; gf++) matriz[gc][gf] /= soma;
  let pCasa = 0, pEmpate = 0, pFora = 0;
  for (let gc = 0; gc <= MAX_GOLS; gc++) {
    for (let gf = 0; gf <= MAX_GOLS; gf++) {
      const p = matriz[gc][gf];
      if (gc > gf) pCasa += p; else if (gc === gf) pEmpate += p; else pFora += p;
    }
  }
  return { pCasa, pEmpate, pFora };
}

function preverConfronto(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLiga(partidasAnteriores, dataReferencia);
  const fc = calcularForcaTime(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const ff = calcularForcaTime(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  if (fc.totalJogos < MINIMO_JOGOS_PARA_PREVER || ff.totalJogos < MINIMO_JOGOS_PARA_PREVER) return null;
  const gec = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora;
  const gef = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;
  return preverPartida(gec, gef);
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

  const inicioTeste = Math.floor(todasPartidas.length * 0.3);
  let n = 0;
  let vezesPrevistaX2 = 0, acertoX2 = 0, baseX2 = 0;

  for (let i = inicioTeste; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);
    const previsao = preverConfronto(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
    if (!previsao) continue;

    n++;
    let real;
    if (partida.gols_casa > partida.gols_fora) real = 'casa';
    else if (partida.gols_casa === partida.gols_fora) real = 'empate';
    else real = 'fora';

    const p1X = previsao.pCasa + previsao.pEmpate;
    const pX2 = previsao.pEmpate + previsao.pFora;
    const p12 = previsao.pCasa + previsao.pFora;
    const duplas = { '1X': p1X, 'X2': pX2, '12': p12 };
    const previstaDupla = Object.entries(duplas).sort((a, b) => b[1] - a[1])[0][0];

    const resultouEmX2 = real === 'empate' || real === 'fora';
    if (resultouEmX2) baseX2++;

    if (previstaDupla === 'X2') {
      vezesPrevistaX2++;
      if (resultouEmX2) acertoX2++;
    }
  }

  const precisaoX2 = vezesPrevistaX2 > 0 ? (acertoX2 / vezesPrevistaX2) * 100 : 0;
  const baselineX2 = (baseX2 / n) * 100;

  console.log(`\n=== ${comp.nome} ===`);
  console.log(`  Previsões totais: ${n}`);
  console.log(`  X2 previsto em: ${vezesPrevistaX2} jogos`);
  console.log(`  Precisão do X2 quando previsto: ${precisaoX2.toFixed(1)}%`);
  console.log(`  Linha de base (frequência real de X2 na amostra): ${baselineX2.toFixed(1)}%`);
  console.log(`  ${precisaoX2 > baselineX2 ? '✅ SUPERA' : '❌ NÃO supera'} a linha de base`);

  return { nome: comp.nome, precisaoX2, baselineX2, vezesPrevistaX2 };
}

async function main() {
  console.log('Validando o achado "X2" (empate ou fora) fora da amostra da Série A...\n');
  const resultados = [];
  for (const apiFootballId of [72, 75, 76]) { // Série B, Série C, Série D
    const r = await validarCompeticao(apiFootballId);
    if (r) resultados.push(r);
  }

  console.log('\n\n=== Resumo da validação fora da amostra ===');
  for (const r of resultados) {
    const status = r.precisaoX2 > r.baselineX2 ? '✅' : '❌';
    console.log(`${status} ${r.nome}: ${r.precisaoX2.toFixed(1)}% vs linha de base ${r.baselineX2.toFixed(1)}% (previsto em ${r.vezesPrevistaX2} jogos)`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
