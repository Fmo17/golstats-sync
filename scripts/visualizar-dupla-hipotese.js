/**
 * visualizar-dupla-hipotese.js
 *
 * Mostra, PARTIDA POR PARTIDA, o raciocínio completo do X2: as 3
 * probabilidades base do modelo de Poisson (casa/empate/fora), as 3
 * combinações de dupla hipótese (1X/X2/12), qual foi escolhida, e o
 * resultado real.
 *
 * Uso:
 *   node scripts/visualizar-dupla-hipotese.js --competicao=71 --jogos=20
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
const RHO_DIXON_COLES = -0.13;

function fatorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poisson(k, lambda) { return (Math.exp(-lambda) * Math.pow(lambda, k)) / fatorial(k); }
function pesoDecaimento(dias) { return Math.pow(0.5, dias / MEIA_VIDA_DIAS); }

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

function preverProbabilidades(gec, gef) {
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

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const jogosArg = args.find((a) => a.startsWith('--jogos='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;
  const numJogosMostrar = jogosArg ? parseInt(jogosArg.split('=')[1], 10) : 20;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { data: todasPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora, times_casa:times!partidas_time_casa_id_fkey(nome), times_fora:times!partidas_time_fora_id_fkey(nome)')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  console.log(`${comp.nome} -- ${todasPartidas.length} partidas no banco.\n`);

  const inicioValido = Math.floor(todasPartidas.length * 0.3); // mesmo aquecimento do backtest oficial
  let mostradas = 0;
  let acertos = 0;
  let previstosX2 = 0;

  for (let i = inicioValido; i < todasPartidas.length && mostradas < numJogosMostrar; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    const { mediaGolsCasa, mediaGolsFora } = calcularMediasLiga(anteriores, partida.data_hora);
    const fc = calcularForcaTime(anteriores, partida.time_casa_id, partida.data_hora, mediaGolsCasa, mediaGolsFora);
    const ff = calcularForcaTime(anteriores, partida.time_fora_id, partida.data_hora, mediaGolsCasa, mediaGolsFora);
    if (fc.totalJogos < 6 || ff.totalJogos < 6) continue;

    const gec = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora;
    const gef = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;
    const { pCasa, pEmpate, pFora } = preverProbabilidades(gec, gef);

    const p1X = pCasa + pEmpate;
    const pX2 = pEmpate + pFora;
    const p12 = pCasa + pFora;
    const duplas = { '1X': p1X, 'X2': pX2, '12': p12 };
    const previstaDupla = Object.entries(duplas).sort((a, b) => b[1] - a[1])[0][0];

    let resultadoReal;
    if (partida.gols_casa > partida.gols_fora) resultadoReal = 'casa';
    else if (partida.gols_casa === partida.gols_fora) resultadoReal = 'empate';
    else resultadoReal = 'fora';

    if (previstaDupla !== 'X2') continue; // só mostra jogos onde o modelo indicou X2 (o foco dessa análise)

    mostradas++;
    previstosX2++;

    const resultouEmX2 = resultadoReal === 'empate' || resultadoReal === 'fora';
    if (resultouEmX2) acertos++;

    const nomeCasa = partida.times_casa?.nome || `Time ${partida.time_casa_id}`;
    const nomeFora = partida.times_fora?.nome || `Time ${partida.time_fora_id}`;

    console.log(`--- Jogo ${mostradas}: ${nomeCasa} x ${nomeFora} (${new Date(partida.data_hora).toLocaleDateString('pt-BR')}) ---`);
    console.log(`  Probabilidades base -- Casa: ${(pCasa * 100).toFixed(1)}% | Empate: ${(pEmpate * 100).toFixed(1)}% | Fora: ${(pFora * 100).toFixed(1)}%`);
    console.log(`  Duplas hipóteses -- 1X: ${(p1X * 100).toFixed(1)}% | X2: ${(pX2 * 100).toFixed(1)}% | 12: ${(p12 * 100).toFixed(1)}%`);
    console.log(`  Dupla escolhida: X2 (empate ou vitória de fora)`);
    console.log(`  Resultado real: ${resultadoReal.toUpperCase()} (${partida.gols_casa} x ${partida.gols_fora})  ${resultouEmX2 ? '✅ ACERTOU (X2)' : '❌ ERROU (saiu vitória da casa)'}\n`);
  }

  console.log(`\n=== Resumo dos ${mostradas} jogos mostrados (onde o modelo indicou X2) ===`);
  console.log(`Acertos: ${acertos} de ${previstosX2} (${((acertos / previstosX2) * 100).toFixed(1)}%)`);
  console.log('\n(Mostrando só os jogos onde o X2 foi a dupla escolhida -- pra ver mais, roda com --jogos=40.)');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
