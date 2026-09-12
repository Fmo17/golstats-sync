/**
 * seletividade-1x.js
 *
 * Aplica a mesma lógica de seletividade que validamos pra vitória do
 * mandante, agora pro 1X (casa ou empate): testa se filtrar só os jogos
 * onde o modelo calcula probabilidade ALTA de 1X realmente aumenta a taxa
 * de acerto real, comparado com a linha de base daquele mesmo subconjunto.
 *
 * Uso:
 *   node scripts/seletividade-1x.js --competicao=71
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
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  console.log(`Carregando partidas de: ${comp.nome}...`);
  const { data: todasPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  console.log(`${todasPartidas.length} partidas carregadas.\n`);

  const inicioValido = Math.floor(todasPartidas.length * 0.3);
  const jogos = []; // { p1X, resultouEm1X }

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
    const resultouEm1X = partida.gols_casa >= partida.gols_fora; // casa venceu OU empatou

    jogos.push({ p1X, resultouEm1X });
  }

  console.log(`Partidas analisadas: ${jogos.length}\n`);

  const limiares = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];

  console.log('Limiar (prob. 1X) | Jogos no subconjunto | Taxa real de 1X nesse subconjunto');
  console.log('-------------------|----------------------|-----------------------------------');

  for (const limiar of limiares) {
    const subconjunto = jogos.filter((j) => j.p1X > limiar);
    if (subconjunto.length < 20) continue;
    const acertos = subconjunto.filter((j) => j.resultouEm1X).length;
    const taxa = (acertos / subconjunto.length) * 100;
    console.log(`${limiar.toFixed(2).padEnd(19)} | ${String(subconjunto.length).padEnd(20)} | ${acertos}/${subconjunto.length} (${taxa.toFixed(1)}%)`);
  }

  const taxaBaseGeral = (jogos.filter((j) => j.resultouEm1X).length / jogos.length) * 100;
  console.log(`\nLinha de base geral (frequência real de 1X em toda a amostra): ${taxaBaseGeral.toFixed(1)}%`);
  console.log('\n(Se a taxa sobe conforme o limiar aumenta, o modelo está calibrado corretamente pro 1X --');
  console.log('quanto mais confiante ele diz estar, mais vezes deveria acertar de verdade.)');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
