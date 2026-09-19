/**
 * validar-mercados.js
 *
 * Testa o modelo de Poisson já validado (janela=25, Dixon-Coles) em mercados
 * DERIVADOS da mesma distribuição de probabilidade -- sem precisar de novo
 * treinamento, só reaproveitando o que já sabemos calcular:
 *
 *  - 1x2 (vitória casa / empate / vitória fora) -- já validado antes, incluído aqui de novo como referência
 *  - Dupla hipótese (1X, X2, 12)
 *  - Gols na partida (1+) -- probabilidade de sair pelo menos 1 gol (total)
 *
 * Uso:
 *   node scripts/validar-mercados.js --competicao=71
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

// CORRIGIDO em 2026-09-16: usava .slice(0, JANELA_JOGOS), que pega os N jogos
// MAIS ANTIGOS de um array ordenado do mais antigo pro mais recente (bug
// idêntico ao encontrado e corrigido no gerar-sinais.js). Agora usa
// .slice(-JANELA_JOGOS), que pega os N mais RECENTES -- consistente com o
// motor de produção.
function calcularForcaTime(partidas, timeId, dataReferencia, mgc, mgf) {
  const jc = partidas.filter((p) => p.time_casa_id === timeId).slice(-JANELA_JOGOS);
  const jf = partidas.filter((p) => p.time_fora_id === timeId).slice(-JANELA_JOGOS);
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

  let pCasa = 0, pEmpate = 0, pFora = 0, pGol1Mais = 0;
  for (let gc = 0; gc <= MAX_GOLS; gc++) {
    for (let gf = 0; gf <= MAX_GOLS; gf++) {
      const p = matriz[gc][gf];
      if (gc > gf) pCasa += p;
      else if (gc === gf) pEmpate += p;
      else pFora += p;
      if (gc + gf >= 1) pGol1Mais += p;
    }
  }
  return { pCasa, pEmpate, pFora, pGol1Mais };
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
  console.log(`${todasPartidas.length} partidas carregadas.\n`);

  const inicioTeste = Math.floor(todasPartidas.length * 0.3);

  let n = 0, acerto1x2 = 0, acertoBase1x2 = 0;
  let acerto1X = 0, acertoX2 = 0, acerto12 = 0;
  let vezesPrevista1X = 0, vezesPrevistaX2 = 0, vezesPrevista12 = 0;
  let base1X = 0, baseX2 = 0, base12 = 0;
  let acertoGol1Mais = 0, baseGol1Mais = 0;

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

    const probs = { casa: previsao.pCasa, empate: previsao.pEmpate, fora: previsao.pFora };
    const previsto1x2 = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    if (previsto1x2 === real) acerto1x2++;
    if (real === 'casa') acertoBase1x2++;

    const p1X = previsao.pCasa + previsao.pEmpate;
    const pX2 = previsao.pEmpate + previsao.pFora;
    const p12 = previsao.pCasa + previsao.pFora;

    const duplas = { '1X': p1X, 'X2': pX2, '12': p12 };
    const previstaDupla = Object.entries(duplas).sort((a, b) => b[1] - a[1])[0][0];

    const resultouEm1X = real === 'casa' || real === 'empate';
    const resultouEmX2 = real === 'empate' || real === 'fora';
    const resultouEm12 = real === 'casa' || real === 'fora';

    if (previstaDupla === '1X') { vezesPrevista1X++; if (resultouEm1X) acerto1X++; }
    if (previstaDupla === 'X2') { vezesPrevistaX2++; if (resultouEmX2) acertoX2++; }
    if (previstaDupla === '12') { vezesPrevista12++; if (resultouEm12) acerto12++; }

    if (resultouEm1X) base1X++;
    if (resultouEmX2) baseX2++;
    if (resultouEm12) base12++;

    const golReal1Mais = (partida.gols_casa + partida.gols_fora) >= 1;
    const previuGol1Mais = previsao.pGol1Mais > 0.5;
    if (previuGol1Mais === golReal1Mais) acertoGol1Mais++;
    if (golReal1Mais) baseGol1Mais++;
  }

  console.log(`Previsões testadas: ${n}\n`);

  console.log('=== 1x2 (vitória casa / empate / vitória fora) ===');
  console.log(`  Modelo: ${((acerto1x2 / n) * 100).toFixed(1)}%  |  Linha de base (sempre casa): ${((acertoBase1x2 / n) * 100).toFixed(1)}%`);
  console.log(`  ${acerto1x2 > acertoBase1x2 ? '✅ SUPERA' : '❌ NÃO supera'}\n`);

  console.log('=== Dupla hipótese ===');
  console.log(`  1X (casa ou empate): previsto em ${vezesPrevista1X} jogos, acertou ${vezesPrevista1X > 0 ? ((acerto1X / vezesPrevista1X) * 100).toFixed(1) : '0.0'}% deles | frequência real do 1X na amostra inteira: ${((base1X / n) * 100).toFixed(1)}%`);
  console.log(`  X2 (empate ou fora): previsto em ${vezesPrevistaX2} jogos, acertou ${vezesPrevistaX2 > 0 ? ((acertoX2 / vezesPrevistaX2) * 100).toFixed(1) : '0.0'}% deles | frequência real do X2 na amostra inteira: ${((baseX2 / n) * 100).toFixed(1)}%`);
  console.log(`  12 (casa ou fora, ou seja "não empate"): previsto em ${vezesPrevista12} jogos, acertou ${vezesPrevista12 > 0 ? ((acerto12 / vezesPrevista12) * 100).toFixed(1) : '0.0'}% deles | frequência real do 12 na amostra inteira: ${((base12 / n) * 100).toFixed(1)}%`);
  console.log(`  (A "frequência real na amostra inteira" de cada dupla já é a linha de base pra ela -- ex: "12" sozinho, sem nenhum modelo, já acontece em ~75% dos jogos, porque empates são minoria.)\n`);

  console.log('=== Gols na partida (1 ou mais, total) ===');
  console.log(`  Modelo: ${((acertoGol1Mais / n) * 100).toFixed(1)}%  |  Linha de base (sempre "sim"): ${((baseGol1Mais / n) * 100).toFixed(1)}%`);
  console.log(`  ${acertoGol1Mais > baseGol1Mais ? '✅ SUPERA' : '❌ NÃO supera'}`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
