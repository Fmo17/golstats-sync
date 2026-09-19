/**
 * scripts/lib/poisson.js
 *
 * Motor de Poisson + Dixon-Coles, compartilhado entre produção (gerar-sinais.js),
 * validação (validar-mercados.js), e experimentos (regressao-logistica-completa.js).
 *
 * Criado em 2026-09-16 pra eliminar o risco de duplicação de código que já
 * causou um bug real (.slice(0, N) pegando jogos antigos em vez de recentes,
 * corrigido separadamente em 3 arquivos diferentes -- esse tipo de bug não
 * pode mais acontecer de forma isolada, porque agora existe uma única
 * implementação, testada, que todo mundo importa.
 *
 * Diferente das versões anteriores (que só devolviam true/false por mercado),
 * essa versão devolve as PROBABILIDADES BRUTAS completas de cada partida --
 * pCasa, pEmpate, pFora, p1X, pX2, pOver05/15/25 -- prontas pra, no futuro,
 * passar por um calibrador (Platt scaling) em vez de virar direto um sinal
 * booleano.
 */

export const JANELA_POISSON = 25;
export const MEIA_VIDA_DIAS = 60;
export const MAX_GOLS = 8;
export const MINIMO_JOGOS_PARA_PREVER = 6;
export const RHO_DIXON_COLES = -0.13;

function fatorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poisson(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fatorial(k);
}

export function pesoDecaimento(diasAtras, meiaVidaDias = MEIA_VIDA_DIAS) {
  return Math.pow(0.5, diasAtras / meiaVidaDias);
}

function ajusteDixonColes(gc, gf, lc, lf, rho) {
  if (gc === 0 && gf === 0) return 1 - lc * lf * rho;
  if (gc === 0 && gf === 1) return 1 + lc * rho;
  if (gc === 1 && gf === 0) return 1 + lf * rho;
  if (gc === 1 && gf === 1) return 1 - rho;
  return 1;
}

/**
 * Média de gols da liga (casa/fora), com peso que diminui com o tempo
 * (meia-vida de 60 dias -- um jogo de 60 dias atrás pesa metade de um jogo
 * de hoje).
 */
export function calcularMediasLiga(partidas, dataReferencia) {
  let sc = 0, sf = 0, sp = 0;
  for (const p of partidas) {
    const dias = (new Date(dataReferencia) - new Date(p.data_hora)) / 86400000;
    const peso = pesoDecaimento(dias);
    sc += p.gols_casa * peso;
    sf += p.gols_fora * peso;
    sp += peso;
  }
  if (sp === 0) return { mediaGolsCasa: 1.3, mediaGolsFora: 1.1 };
  return { mediaGolsCasa: sc / sp, mediaGolsFora: sf / sp };
}

/**
 * Índice de ataque/defesa de um time, relativo à média da liga -- usa os
 * jogos MAIS RECENTES (slice negativo -- esse é exatamente o ponto que
 * estava com bug antes da correção de 2026-09-16).
 */
export function calcularForcaTime(partidas, timeId, dataReferencia, mediaGolsCasaLiga, mediaGolsForaLiga, janela = JANELA_POISSON) {
  const jc = partidas.filter((p) => p.time_casa_id === timeId).slice(-janela);
  const jf = partidas.filter((p) => p.time_fora_id === timeId).slice(-janela);

  function media(jogos, pro, contra) {
    let sp2 = 0, sc2 = 0, sw = 0;
    for (const j of jogos) {
      const dias = (new Date(dataReferencia) - new Date(j.data_hora)) / 86400000;
      const peso = pesoDecaimento(dias);
      sp2 += j[pro] * peso;
      sc2 += j[contra] * peso;
      sw += peso;
    }
    return sw > 0 ? { mediaPro: sp2 / sw, mediaContra: sc2 / sw } : null;
  }

  const emCasa = media(jc, 'gols_casa', 'gols_fora');
  const fora = media(jf, 'gols_fora', 'gols_casa');

  return {
    totalJogos: jc.length + jf.length,
    ataqueCasa: emCasa ? emCasa.mediaPro / mediaGolsCasaLiga : 1,
    defesaCasa: emCasa ? emCasa.mediaContra / mediaGolsForaLiga : 1,
    ataqueFora: fora ? fora.mediaPro / mediaGolsForaLiga : 1,
    defesaFora: fora ? fora.mediaContra / mediaGolsCasaLiga : 1,
  };
}

/**
 * Monta a matriz de probabilidade de cada placar (0x0 até maxGols x maxGols),
 * com o ajuste de Dixon-Coles nos placares baixos -- e devolve todas as
 * probabilidades agregadas derivadas dela: 1x2, dupla hipótese, e over 0.5/1.5/2.5
 * (extraídas direto da distribuição, não mais como regra categórica separada).
 */
export function calcularMatrizProbabilidades(golsEsperadosCasa, golsEsperadosFora, opcoes = {}) {
  const maxGols = opcoes.maxGols ?? MAX_GOLS;
  const rho = opcoes.rho ?? RHO_DIXON_COLES;

  const matriz = [];
  let soma = 0;
  for (let gc = 0; gc <= maxGols; gc++) {
    matriz[gc] = [];
    for (let gf = 0; gf <= maxGols; gf++) {
      const base = poisson(gc, golsEsperadosCasa) * poisson(gf, golsEsperadosFora);
      const ajuste = ajusteDixonColes(gc, gf, golsEsperadosCasa, golsEsperadosFora, rho);
      matriz[gc][gf] = base * ajuste;
      soma += matriz[gc][gf];
    }
  }
  for (let gc = 0; gc <= maxGols; gc++) {
    for (let gf = 0; gf <= maxGols; gf++) {
      matriz[gc][gf] /= soma;
    }
  }

  let pCasa = 0, pEmpate = 0, pFora = 0;
  let pTotalAte0 = 0, pTotalAte1 = 0, pTotalAte2 = 0;

  for (let gc = 0; gc <= maxGols; gc++) {
    for (let gf = 0; gf <= maxGols; gf++) {
      const p = matriz[gc][gf];
      if (gc > gf) pCasa += p;
      else if (gc === gf) pEmpate += p;
      else pFora += p;

      const totalGols = gc + gf;
      if (totalGols <= 0) pTotalAte0 += p;
      if (totalGols <= 1) pTotalAte1 += p;
      if (totalGols <= 2) pTotalAte2 += p;
    }
  }

  return {
    matriz,
    pCasa,
    pEmpate,
    pFora,
    p1X: pCasa + pEmpate,
    pX2: pEmpate + pFora,
    p12: pCasa + pFora,
    // Over N.5 = 1 - P(total de gols <= N) -- extraído direto da distribuição,
    // não é mais uma regra categórica separada de "gols 1+/2+/3+"
    pOver05: 1 - pTotalAte0,
    pOver15: 1 - pTotalAte1,
    pOver25: 1 - pTotalAte2,
  };
}

/**
 * Função principal: recebe o histórico de partidas ANTERIORES ao jogo (já
 * filtrado cronologicamente por quem chama), os 2 times, e a data de
 * referência -- devolve o objeto completo de probabilidades, ou null se não
 * tiver jogos suficientes pra confiar na previsão.
 */
export function preverConfronto(partidasAnteriores, timeCasaId, timeForaId, dataReferencia, opcoes = {}) {
  const janela = opcoes.janela ?? JANELA_POISSON;
  const minimoJogos = opcoes.minimoJogos ?? MINIMO_JOGOS_PARA_PREVER;

  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLiga(partidasAnteriores, dataReferencia);
  const fc = calcularForcaTime(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora, janela);
  const ff = calcularForcaTime(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora, janela);

  if (fc.totalJogos < minimoJogos || ff.totalJogos < minimoJogos) return null;

  const golsEsperadosCasa = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora;
  const golsEsperadosFora = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;

  const probabilidades = calcularMatrizProbabilidades(golsEsperadosCasa, golsEsperadosFora, opcoes);

  return {
    golsEsperadosCasa,
    golsEsperadosFora,
    ...probabilidades,
  };
}
