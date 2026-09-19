/**
 * verificar-biblioteca-poisson.js
 *
 * Prova que a nova biblioteca (scripts/lib/poisson.js) devolve EXATAMENTE
 * os mesmos números que a lógica antiga (já corrigida, copiada aqui como
 * referência independente) -- antes de trocar qualquer coisa em produção.
 *
 * Uso:
 *   node scripts/verificar-biblioteca-poisson.js [--competicao=71] [--amostra=200]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { preverConfronto as preverConfrontoNovo } from './lib/poisson.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ---------- Versão "antiga" (referência independente, copiada do validar-mercados.js já corrigido) ----------
const JANELA_JOGOS = 25;
const MEIA_VIDA_DIAS = 60;
const MAX_GOLS = 8;
const MINIMO_JOGOS_PARA_PREVER = 6;
const RHO_DIXON_COLES = -0.13;

function fatorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poissonRef(k, lambda) { return (Math.exp(-lambda) * Math.pow(lambda, k)) / fatorial(k); }
function pesoDecaimentoRef(diasAtras) { return Math.pow(0.5, diasAtras / MEIA_VIDA_DIAS); }

function ajusteDixonColesRef(gc, gf, lc, lf, rho) {
  if (gc === 0 && gf === 0) return 1 - lc * lf * rho;
  if (gc === 0 && gf === 1) return 1 + lc * rho;
  if (gc === 1 && gf === 0) return 1 + lf * rho;
  if (gc === 1 && gf === 1) return 1 - rho;
  return 1;
}

function calcularMediasLigaRef(partidas, dataReferencia) {
  let sc = 0, sf = 0, sp = 0;
  for (const p of partidas) {
    const dias = (new Date(dataReferencia) - new Date(p.data_hora)) / 86400000;
    const peso = pesoDecaimentoRef(dias);
    sc += p.gols_casa * peso; sf += p.gols_fora * peso; sp += peso;
  }
  if (sp === 0) return { mediaGolsCasa: 1.3, mediaGolsFora: 1.1 };
  return { mediaGolsCasa: sc / sp, mediaGolsFora: sf / sp };
}

function calcularForcaTimeRef(partidas, timeId, dataReferencia, mgc, mgf) {
  const jc = partidas.filter((p) => p.time_casa_id === timeId).slice(-JANELA_JOGOS);
  const jf = partidas.filter((p) => p.time_fora_id === timeId).slice(-JANELA_JOGOS);
  function media(jogos, pro, contra) {
    let sp2 = 0, sc2 = 0, sw = 0;
    for (const j of jogos) {
      const dias = (new Date(dataReferencia) - new Date(j.data_hora)) / 86400000;
      const peso = pesoDecaimentoRef(dias);
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

function preverPartidaRef(gec, gef) {
  const matriz = [];
  let soma = 0;
  for (let gc = 0; gc <= MAX_GOLS; gc++) {
    matriz[gc] = [];
    for (let gf = 0; gf <= MAX_GOLS; gf++) {
      const base = poissonRef(gc, gec) * poissonRef(gf, gef);
      const ajuste = ajusteDixonColesRef(gc, gf, gec, gef, RHO_DIXON_COLES);
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

function preverConfrontoRef(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLigaRef(partidasAnteriores, dataReferencia);
  const fc = calcularForcaTimeRef(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const ff = calcularForcaTimeRef(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  if (fc.totalJogos < MINIMO_JOGOS_PARA_PREVER || ff.totalJogos < MINIMO_JOGOS_PARA_PREVER) return null;
  const gec = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora;
  const gef = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;
  return preverPartidaRef(gec, gef);
}

// ---------- Comparação ----------

function proximo(a, b, tolerancia = 0.0000001) {
  return Math.abs(a - b) < tolerancia;
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;
  const amostraArg = args.find((a) => a.startsWith('--amostra='));
  const tamanhoAmostra = amostraArg ? parseInt(amostraArg.split('=')[1], 10) : 200;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { data: todasPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  console.log(`Testando em: ${comp.nome} (${todasPartidas.length} partidas no histórico)\n`);

  let testados = 0;
  let identicos = 0;
  const divergencias = [];

  const inicio = Math.floor(todasPartidas.length * 0.3);
  for (let i = inicio; i < todasPartidas.length && testados < tamanhoAmostra; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    const antigo = preverConfrontoRef(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
    const novo = preverConfrontoNovo(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);

    if (antigo === null && novo === null) continue; // ambos concordam que não tem dado suficiente
    testados++;

    if (antigo === null || novo === null) {
      divergencias.push({ partida: partida.id, motivo: `um retornou null e o outro não (antigo=${antigo === null}, novo=${novo === null})` });
      continue;
    }

    const bateu =
      proximo(antigo.pCasa, novo.pCasa) &&
      proximo(antigo.pEmpate, novo.pEmpate) &&
      proximo(antigo.pFora, novo.pFora);

    if (bateu) {
      identicos++;
    } else {
      divergencias.push({
        partida: partida.id,
        antigo: { pCasa: antigo.pCasa, pEmpate: antigo.pEmpate, pFora: antigo.pFora },
        novo: { pCasa: novo.pCasa, pEmpate: novo.pEmpate, pFora: novo.pFora },
      });
    }
  }

  console.log(`Partidas comparadas: ${testados}`);
  console.log(`Idênticas (pCasa/pEmpate/pFora batendo): ${identicos}`);
  console.log(`Divergentes: ${divergencias.length}\n`);

  if (divergencias.length > 0) {
    console.log('❌ ENCONTREI DIVERGÊNCIAS -- não trocar em produção antes de investigar:\n');
    divergencias.slice(0, 5).forEach((d) => console.log(JSON.stringify(d, null, 2)));
  } else {
    console.log('✅ 100% idêntico -- a biblioteca nova está matematicamente equivalente à antiga.');
    console.log('   Segura pra ser adotada em produção.');
  }

  // Mostra também as probabilidades NOVAS que a lógica antiga não tinha
  // (over 0.5/1.5/2.5), pra conferir que fazem sentido
  const exemplo = todasPartidas[todasPartidas.length - 1];
  const anterioresExemplo = todasPartidas.slice(0, todasPartidas.length - 1);
  const previsaoExemplo = preverConfrontoNovo(anterioresExemplo, exemplo.time_casa_id, exemplo.time_fora_id, exemplo.data_hora);
  if (previsaoExemplo) {
    console.log('\n=== Exemplo das probabilidades NOVAS (não existiam antes) ===');
    console.log(`  pOver05 (1+ gol): ${(previsaoExemplo.pOver05 * 100).toFixed(1)}%`);
    console.log(`  pOver15 (2+ gols): ${(previsaoExemplo.pOver15 * 100).toFixed(1)}%`);
    console.log(`  pOver25 (3+ gols): ${(previsaoExemplo.pOver25 * 100).toFixed(1)}%`);
    console.log(`  p1X: ${(previsaoExemplo.p1X * 100).toFixed(1)}%  |  pX2: ${(previsaoExemplo.pX2 * 100).toFixed(1)}%`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
