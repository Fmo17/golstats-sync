/**
 * verificar-integracao-gerar-sinais.js
 *
 * Confirma que preverX2/preverUm1X, depois de integradas com a biblioteca
 * compartilhada, continuam devolvendo EXATAMENTE o mesmo true/false/null
 * que a lógica antiga (duplicada) devolvia -- teste final antes de
 * confiar a integração em produção.
 *
 * Uso:
 *   node scripts/verificar-integracao-gerar-sinais.js [--competicao=71]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { preverConfronto } from './lib/poisson.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const LIMIAR_1X = 0.65;

// ---------- Versão NOVA (usa a biblioteca, igual ao gerar-sinais.js já integrado) ----------
function preverX2Novo(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const previsao = preverConfronto(partidasAnteriores, timeCasaId, timeForaId, dataReferencia);
  if (!previsao) return null;
  const duplas = { '1X': previsao.p1X, 'X2': previsao.pX2, '12': previsao.p12 };
  const previstaDupla = Object.entries(duplas).sort((a, b) => b[1] - a[1])[0][0];
  return previstaDupla === 'X2';
}
function preverUm1XNovo(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const previsao = preverConfronto(partidasAnteriores, timeCasaId, timeForaId, dataReferencia);
  if (!previsao) return null;
  return previsao.p1X > LIMIAR_1X;
}

// ---------- Versão ANTIGA (referência independente, cópia fiel da lógica original) ----------
const JANELA_JOGOS = 25, MEIA_VIDA_DIAS = 60, MAX_GOLS = 8, RHO = -0.13;
function fatorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poissonRef(k, l) { return (Math.exp(-l) * Math.pow(l, k)) / fatorial(k); }
function pesoRef(dias) { return Math.pow(0.5, dias / MEIA_VIDA_DIAS); }
function ajusteRef(gc, gf, lc, lf, rho) {
  if (gc === 0 && gf === 0) return 1 - lc * lf * rho;
  if (gc === 0 && gf === 1) return 1 + lc * rho;
  if (gc === 1 && gf === 0) return 1 + lf * rho;
  if (gc === 1 && gf === 1) return 1 - rho;
  return 1;
}
function mediasLigaRef(partidas, dataRef) {
  let sc = 0, sf = 0, sp = 0;
  for (const p of partidas) { const d = (new Date(dataRef) - new Date(p.data_hora)) / 86400000; const w = pesoRef(d); sc += p.gols_casa * w; sf += p.gols_fora * w; sp += w; }
  if (sp === 0) return { mediaGolsCasa: 1.3, mediaGolsFora: 1.1 };
  return { mediaGolsCasa: sc / sp, mediaGolsFora: sf / sp };
}
function forcaTimeRef(partidas, timeId, dataRef, mgc, mgf) {
  const jc = partidas.filter((p) => p.time_casa_id === timeId).slice(-JANELA_JOGOS);
  const jf = partidas.filter((p) => p.time_fora_id === timeId).slice(-JANELA_JOGOS);
  function media(jogos, pro, contra) {
    let sp2 = 0, sc2 = 0, sw = 0;
    for (const j of jogos) { const d = (new Date(dataRef) - new Date(j.data_hora)) / 86400000; const w = pesoRef(d); sp2 += j[pro] * w; sc2 += j[contra] * w; sw += w; }
    return sw > 0 ? { mediaPro: sp2 / sw, mediaContra: sc2 / sw } : null;
  }
  const emCasa = media(jc, 'gols_casa', 'gols_fora'), fora = media(jf, 'gols_fora', 'gols_casa');
  return { totalJogos: jc.length + jf.length, ataqueCasa: emCasa ? emCasa.mediaPro / mgc : 1, defesaCasa: emCasa ? emCasa.mediaContra / mgf : 1, ataqueFora: fora ? fora.mediaPro / mgf : 1, defesaFora: fora ? fora.mediaContra / mgc : 1 };
}
function probsRef(gec, gef) {
  const m = []; let soma = 0;
  for (let gc = 0; gc <= MAX_GOLS; gc++) { m[gc] = []; for (let gf = 0; gf <= MAX_GOLS; gf++) { const base = poissonRef(gc, gec) * poissonRef(gf, gef); m[gc][gf] = base * ajusteRef(gc, gf, gec, gef, RHO); soma += m[gc][gf]; } }
  for (let gc = 0; gc <= MAX_GOLS; gc++) for (let gf = 0; gf <= MAX_GOLS; gf++) m[gc][gf] /= soma;
  let pCasa = 0, pEmpate = 0, pFora = 0;
  for (let gc = 0; gc <= MAX_GOLS; gc++) for (let gf = 0; gf <= MAX_GOLS; gf++) { const p = m[gc][gf]; if (gc > gf) pCasa += p; else if (gc === gf) pEmpate += p; else pFora += p; }
  return { pCasa, pEmpate, pFora };
}
function preverX2Antigo(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = mediasLigaRef(partidasAnteriores, dataReferencia);
  const fc = forcaTimeRef(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const ff = forcaTimeRef(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  if (fc.totalJogos < 6 || ff.totalJogos < 6) return null;
  const gec = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora, gef = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;
  const { pCasa, pEmpate, pFora } = probsRef(gec, gef);
  const duplas = { '1X': pCasa + pEmpate, 'X2': pEmpate + pFora, '12': pCasa + pFora };
  return Object.entries(duplas).sort((a, b) => b[1] - a[1])[0][0] === 'X2';
}
function preverUm1XAntigo(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = mediasLigaRef(partidasAnteriores, dataReferencia);
  const fc = forcaTimeRef(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const ff = forcaTimeRef(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  if (fc.totalJogos < 6 || ff.totalJogos < 6) return null;
  const gec = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora, gef = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;
  const { pCasa, pEmpate } = probsRef(gec, gef);
  return (pCasa + pEmpate) > LIMIAR_1X;
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  const { data: todasPartidas } = await supabase
    .from('partidas').select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  console.log(`Testando em: ${comp.nome} (${todasPartidas.length} partidas)\n`);

  let testados = 0, x2Iguais = 0, um1xIguais = 0;
  const divergenciasX2 = [], divergencias1X = [];

  const inicio = Math.floor(todasPartidas.length * 0.3);
  for (let i = inicio; i < todasPartidas.length; i++) {
    const p = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    const x2Antigo = preverX2Antigo(anteriores, p.time_casa_id, p.time_fora_id, p.data_hora);
    const x2Novo = preverX2Novo(anteriores, p.time_casa_id, p.time_fora_id, p.data_hora);
    const um1xAntigo = preverUm1XAntigo(anteriores, p.time_casa_id, p.time_fora_id, p.data_hora);
    const um1xNovo = preverUm1XNovo(anteriores, p.time_casa_id, p.time_fora_id, p.data_hora);

    if (x2Antigo === null && x2Novo === null) {} else {
      testados++;
      if (x2Antigo === x2Novo) x2Iguais++; else divergenciasX2.push({ partida: p.id, antigo: x2Antigo, novo: x2Novo });
    }
    if (um1xAntigo === null && um1xNovo === null) {} else {
      if (um1xAntigo === um1xNovo) um1xIguais++; else divergencias1X.push({ partida: p.id, antigo: um1xAntigo, novo: um1xNovo });
    }
  }

  console.log(`X2  -- comparados: ${testados}, iguais: ${x2Iguais}, divergentes: ${divergenciasX2.length}`);
  console.log(`1X  -- iguais: ${um1xIguais}, divergentes: ${divergencias1X.length}\n`);

  if (divergenciasX2.length === 0 && divergencias1X.length === 0) {
    console.log('✅ Integração 100% equivalente à lógica anterior -- segura pra produção.');
  } else {
    console.log('❌ DIVERGÊNCIAS ENCONTRADAS -- não usar em produção ainda:');
    [...divergenciasX2, ...divergencias1X].slice(0, 5).forEach((d) => console.log(JSON.stringify(d)));
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
