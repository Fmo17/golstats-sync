/**
 * scripts/avaliar-calibracao.js
 *
 * ETAPA 1 (v2, revisada com o ChatGPT) do experimento offline de
 * calibração. Mudanças desde a v1:
 *
 *  - Divisão treino/validação/teste por FRONTEIRA DE DIA, não por posição
 *    no array -- evita partir o mesmo dia (jogos simultâneos) entre 2
 *    conjuntos diferentes.
 *  - AUC por mercado, pra medir capacidade de SEPARAR jogos (calibração
 *    boa não implica discriminação boa -- um modelo "sempre a taxa média"
 *    pode estar bem calibrado e ainda ter AUC=0.5, ou seja, zero utilidade
 *    prática).
 *  - Bootstrap pareado (2000 repetições) pra saber se a diferença de Brier
 *    entre Platt e a taxa constante é estatisticamente real, ou só ruído.
 *  - Avaliação também dentro da REGIÃO que a produção realmente usaria
 *    hoje (p1X > 0.65 pro mercado 1X; X2 sendo a maior dupla das 3, pro
 *    mercado X2) -- pra saber se o ganho existe exatamente onde importa,
 *    não só na média geral.
 *
 * Uso:
 *   node scripts/avaliar-calibracao.js
 */

import { readFileSync } from 'node:fs';
import { treinarPlatt, aplicarPlatt } from './lib/calibracao.js';
import { brierScore, logLoss, curvaCalibracao, calcularAUC, bootstrapDiferencaBrier } from './lib/metricas.js';

const MERCADOS = [
  { chave: 'p1X', resultado: 'resultado_1X', nome: 'Dupla 1X' },
  { chave: 'pX2', resultado: 'resultado_X2', nome: 'Dupla X2' },
  { chave: 'pOver05', resultado: 'resultado_over05', nome: 'Gols 1+ (Over 0.5)' },
  { chave: 'pOver15', resultado: 'resultado_over15', nome: 'Gols 2+ (Over 1.5)' },
  { chave: 'pOver25', resultado: 'resultado_over25', nome: 'Gols 3+ (Over 2.5)' },
];

/**
 * Move o índice de corte pra frente até cair numa mudança de dia -- assim
 * nenhum dia fica com jogos espalhados entre 2 conjuntos diferentes.
 */
function ajustarCorteParaFronteiraDia(dataset, indiceAlvo) {
  let i = indiceAlvo;
  const diaDoIndice = (idx) => dataset[idx].data_hora.slice(0, 10);
  while (i < dataset.length && i > 0 && diaDoIndice(i) === diaDoIndice(i - 1)) {
    i++;
  }
  return Math.min(i, dataset.length);
}

function main() {
  const caminho = './experimentos/dataset-calibracao.json';
  const dataset = JSON.parse(readFileSync(caminho, 'utf-8'));

  console.log(`Dataset carregado: ${dataset.length} partidas (já ordenado cronologicamente)\n`);

  const corteTreinoAlvo = Math.floor(dataset.length * 0.6);
  const corteValidacaoAlvo = Math.floor(dataset.length * 0.8);
  const corteTreino = ajustarCorteParaFronteiraDia(dataset, corteTreinoAlvo);
  const corteValidacao = ajustarCorteParaFronteiraDia(dataset, corteValidacaoAlvo);

  const treino = dataset.slice(0, corteTreino);
  const validacao = dataset.slice(corteTreino, corteValidacao);
  const testeFinal = dataset.slice(corteValidacao); // carregado, NUNCA avaliado nesse script

  console.log(`Treino: ${treino.length} (até ${treino[treino.length - 1]?.data_hora.slice(0, 10)})`);
  console.log(`Validação: ${validacao.length} (${validacao[0]?.data_hora.slice(0, 10)} até ${validacao[validacao.length - 1]?.data_hora.slice(0, 10)})`);
  console.log(`Teste final (RESERVADO, não avaliado ainda): ${testeFinal.length} (a partir de ${testeFinal[0]?.data_hora.slice(0, 10)})`);
  console.log(`(Cortes ajustados pra cair em fronteira de dia -- nenhum dia fica dividido entre 2 conjuntos.)\n`);

  const LIMIAR_1X_PRODUCAO = 0.65;

  for (const mercado of MERCADOS) {
    console.log(`\n=================== ${mercado.nome} ===================`);

    const probsTreino = treino.map((l) => l[mercado.chave]);
    const resultadosTreino = treino.map((l) => l[mercado.resultado]);

    const probsValidacao = validacao.map((l) => l[mercado.chave]);
    const resultadosValidacao = validacao.map((l) => l[mercado.resultado]);

    const brierBruto = brierScore(probsValidacao, resultadosValidacao);
    const logLossBruto = logLoss(probsValidacao, resultadosValidacao);
    const aucBruto = calcularAUC(probsValidacao, resultadosValidacao);

    const calibrador = treinarPlatt(probsTreino, resultadosTreino);
    const probsCalibradas = probsValidacao.map((p) => aplicarPlatt(p, calibrador));
    const brierPlatt = brierScore(probsCalibradas, resultadosValidacao);
    const logLossPlatt = logLoss(probsCalibradas, resultadosValidacao);
    const aucPlatt = calcularAUC(probsCalibradas, resultadosValidacao);

    const taxaConstante = resultadosTreino.reduce((s, r) => s + (r ? 1 : 0), 0) / resultadosTreino.length;
    const probsConstante = validacao.map(() => taxaConstante);
    const brierConstante = brierScore(probsConstante, resultadosValidacao);
    const logLossConstante = logLoss(probsConstante, resultadosValidacao);

    console.log(`\nCalibrador: a=${calibrador.a.toFixed(4)}, b=${calibrador.b.toFixed(4)} (treinado com n=${calibrador.n})`);
    console.log(`  -> b indica quanto o Poisson bruto está "exagerado" (b=1 seria escala perfeita, b perto de 0 achata quase tudo pra constante)`);
    console.log(`Taxa histórica constante (do treino): ${(taxaConstante * 100).toFixed(1)}%\n`);

    console.log('Comparação na validação:');
    console.log(`  ${'Candidato'.padEnd(28)} Brier      Log loss   AUC`);
    console.log(`  ${'Bruto (Poisson sem calibrar)'.padEnd(28)} ${brierBruto.toFixed(4)}     ${logLossBruto.toFixed(4)}     ${aucBruto !== null ? aucBruto.toFixed(3) : 'n/a'}`);
    console.log(`  ${'Platt (calibrado)'.padEnd(28)} ${brierPlatt.toFixed(4)}     ${logLossPlatt.toFixed(4)}     ${aucPlatt !== null ? aucPlatt.toFixed(3) : 'n/a'}`);
    console.log(`  ${'Taxa histórica constante'.padEnd(28)} ${brierConstante.toFixed(4)}     ${logLossConstante.toFixed(4)}     0.500 (esperado -- constante não separa nada)`);

    const melhoraRelativa = ((brierConstante - brierPlatt) / brierConstante) * 100;
    console.log(`\n  Melhora relativa do Platt sobre a constante: ${melhoraRelativa.toFixed(1)}%`);

    console.log('\n  Bootstrap (2000 repetições) -- Platt vs. Taxa constante, diferença de Brier:');
    const bootPlattVsConstante = bootstrapDiferencaBrier(probsCalibradas, probsConstante, resultadosValidacao);
    console.log(`    diferença média: ${bootPlattVsConstante.diferencaMedia.toFixed(4)}  |  intervalo 95%: [${bootPlattVsConstante.intervalo95[0].toFixed(4)}, ${bootPlattVsConstante.intervalo95[1].toFixed(4)}]`);
    console.log(`    ${bootPlattVsConstante.atravessaZero ? '⚠️  intervalo ATRAVESSA ZERO -- diferença NÃO é estatisticamente confiável' : '✅ intervalo não atravessa zero -- diferença é real'}`);

    console.log('\nCurva de calibração -- Platt:');
    const curva = curvaCalibracao(probsCalibradas, resultadosValidacao);
    for (const c of curva) {
      if (c.n === 0) { console.log(`  ${c.faixa}: sem casos`); continue; }
      console.log(`  ${c.faixa}: previsto ${(c.probMedia * 100).toFixed(1)}% | real ${(c.taxaReal * 100).toFixed(1)}% | diferença ${(c.diferenca * 100).toFixed(1)}pp (n=${c.n})`);
    }

    // ---------- Avaliação dentro da região que a produção usaria hoje ----------
    if (mercado.chave === 'p1X') {
      const indicesFiltroProducao = [];
      for (let i = 0; i < validacao.length; i++) if (validacao[i].p1X > LIMIAR_1X_PRODUCAO) indicesFiltroProducao.push(i);
      if (indicesFiltroProducao.length > 0) {
        const probsFiltro = indicesFiltroProducao.map((i) => probsCalibradas[i]);
        const probsConstFiltro = indicesFiltroProducao.map(() => taxaConstante);
        const resultadosFiltro = indicesFiltroProducao.map((i) => resultadosValidacao[i]);
        console.log(`\nDentro do filtro de produção (p1X > ${LIMIAR_1X_PRODUCAO}) -- n=${indicesFiltroProducao.length}:`);
        console.log(`  Brier Platt: ${brierScore(probsFiltro, resultadosFiltro).toFixed(4)}  |  Brier constante: ${brierScore(probsConstFiltro, resultadosFiltro).toFixed(4)}`);
        console.log(`  Taxa real de acerto nessa região: ${((resultadosFiltro.reduce((s, r) => s + (r ? 1 : 0), 0) / resultadosFiltro.length) * 100).toFixed(1)}%`);
      }
    }
    if (mercado.chave === 'pX2') {
      const indicesFiltroProducao = [];
      for (let i = 0; i < validacao.length; i++) {
        const l = validacao[i];
        if (l.pX2 >= l.p1X && l.pX2 >= l.p12) indicesFiltroProducao.push(i);
      }
      if (indicesFiltroProducao.length > 0) {
        const probsFiltro = indicesFiltroProducao.map((i) => probsCalibradas[i]);
        const probsConstFiltro = indicesFiltroProducao.map(() => taxaConstante);
        const resultadosFiltro = indicesFiltroProducao.map((i) => resultadosValidacao[i]);
        console.log(`\nDentro do filtro de produção (X2 é a maior das 3 duplas) -- n=${indicesFiltroProducao.length}:`);
        console.log(`  Brier Platt: ${brierScore(probsFiltro, resultadosFiltro).toFixed(4)}  |  Brier constante: ${brierScore(probsConstFiltro, resultadosFiltro).toFixed(4)}`);
        console.log(`  Taxa real de acerto nessa região: ${((resultadosFiltro.reduce((s, r) => s + (r ? 1 : 0), 0) / resultadosFiltro.length) * 100).toFixed(1)}%`);
      }
    }
  }

  console.log('\n\n⚠️  Lembrete: o período de teste final NÃO foi avaliado aqui -- fica reservado.');
}

main();
