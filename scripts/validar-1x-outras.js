/**
 * validar-1x-outras.js
 *
 * Aplica o MESMO limiar (0.65, ponto onde a taxa começa a subir de forma
 * mais consistente na Série A) nas outras competições, sem reajustar nada.
 *
 * Uso:
 *   node scripts/validar-1x-outras.js
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
const LIMIAR_FIXO = 0.65;

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

async function validarCompeticao(apiFootballId) {
  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.log(`Competição ${apiFootballId} não encontrada.`); return; }

  const { data: todasPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  const inicioValido = Math.floor(todasPartidas.length * 0.3);
  let n = 0, vezesPrevisto = 0, acertos = 0, baseTotal = 0;

  for (let i = inicioValido; i < todasPartidas.length; i++) {
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
    const resultouEm1X = partida.gols_casa >= partida.gols_fora;

    n++;
    if (resultouEm1X) baseTotal++;

    if (p1X > LIMIAR_FIXO) {
      vezesPrevisto++;
      if (resultouEm1X) acertos++;
    }
  }

  const taxa = vezesPrevisto > 0 ? (acertos / vezesPrevisto) * 100 : 0;
  const baseline = (baseTotal / n) * 100;

  console.log(`\n=== ${comp.nome} ===`);
  console.log(`  Jogos com prob. 1X > ${LIMIAR_FIXO}: ${vezesPrevisto} de ${n}`);
  console.log(`  Taxa real de 1X nesse subconjunto: ${taxa.toFixed(1)}%`);
  console.log(`  Linha de base geral (frequência de 1X no campeonato): ${baseline.toFixed(1)}%`);
  console.log(`  ${taxa > baseline ? '✅ SUPERA' : '❌ NÃO supera'} a linha de base`);
}

async function main() {
  console.log(`Validando limiar fixo (prob. 1X > ${LIMIAR_FIXO}) fora da amostra da Série A...`);
  for (const apiFootballId of [72, 75, 76]) {
    await validarCompeticao(apiFootballId);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
