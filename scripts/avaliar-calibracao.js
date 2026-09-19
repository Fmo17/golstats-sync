/**
 * scripts/avaliar-calibracao.js
 *
 * ETAPA 1 (v3, revisada com o ChatGPT) do experimento offline de
 * calibração. Mudanças desde a v2:
 *
 *  - Baseline DENTRO do filtro de produção agora usa a taxa constante do
 *    subconjunto do TREINO que também passa pelo mesmo filtro -- não mais
 *    a constante geral (que superestimava o ganho, porque o próprio filtro
 *    já seleciona jogos mais prováveis).
 *  - Bootstrap agrupado por DIA (não mais linha a linha), com semente fixa
 *    (reproduzível) -- tanto geral quanto dentro do filtro.
 *  - AUC/Brier/log loss calculados também DENTRO do filtro de produção.
 *  - Quebra por competição pra 1X/X2, confirmando que o ganho não vem de
 *    uma liga só dominando a média.
 *
 * Uso:
 *   node scripts/avaliar-calibracao.js
 */

import { readFileSync } from 'node:fs';
import { treinarPlatt, aplicarPlatt } from './lib/calibracao.js';
import { brierScore, logLoss, curvaCalibracao, calcularAUC, bootstrapDiferencaBrierPorDia } from './lib/metricas.js';

const MERCADOS = [
  { chave: 'p1X', resultado: 'resultado_1X', nome: 'Dupla 1X' },
  { chave: 'pX2', resultado: 'resultado_X2', nome: 'Dupla X2' },
  { chave: 'pOver05', resultado: 'resultado_over05', nome: 'Gols 1+ (Over 0.5)' },
  { chave: 'pOver15', resultado: 'resultado_over15', nome: 'Gols 2+ (Over 1.5)' },
  { chave: 'pOver25', resultado: 'resultado_over25', nome: 'Gols 3+ (Over 2.5)' },
];

const LIMIAR_1X_PRODUCAO = 0.65;

function ajustarCorteParaFronteiraDia(dataset, indiceAlvo) {
  let i = indiceAlvo;
  const diaDoIndice = (idx) => dataset[idx].data_hora.slice(0, 10);
  while (i < dataset.length && i > 0 && diaDoIndice(i) === diaDoIndice(i - 1)) i++;
  return Math.min(i, dataset.length);
}

// Filtro de produção de cada mercado -- usado tanto no treino (pra achar o
// baseline certo) quanto na validação (pra avaliar de verdade nessa região)
function passaFiltroProducao(linha, mercadoChave) {
  if (mercadoChave === 'p1X') return linha.p1X > LIMIAR_1X_PRODUCAO;
  if (mercadoChave === 'pX2') return linha.pX2 > linha.p1X && linha.pX2 >= linha.p12;
  return null; // gols não tem filtro de produção via Poisson (usa regra percentual, motor diferente)
}

function avaliarConjunto(linhas, probs, resultados, rotulo) {
  const brier = brierScore(probs, resultados);
  const ll = logLoss(probs, resultados);
  const auc = calcularAUC(probs, resultados);
  console.log(`  ${rotulo.padEnd(30)} Brier=${brier.toFixed(4)}  LogLoss=${ll.toFixed(4)}  AUC=${auc !== null ? auc.toFixed(3) : 'n/a'}  (n=${linhas.length})`);
  return { brier, ll, auc };
}

function main() {
  const caminho = './experimentos/dataset-calibracao.json';
  const dataset = JSON.parse(readFileSync(caminho, 'utf-8'));

  console.log(`Dataset carregado: ${dataset.length} partidas\n`);

  const corteTreino = ajustarCorteParaFronteiraDia(dataset, Math.floor(dataset.length * 0.6));
  const corteValidacao = ajustarCorteParaFronteiraDia(dataset, Math.floor(dataset.length * 0.8));

  const treino = dataset.slice(0, corteTreino);
  const validacao = dataset.slice(corteTreino, corteValidacao);
  const testeFinal = dataset.slice(corteValidacao);

  console.log(`Treino: ${treino.length} (até ${treino[treino.length - 1]?.data_hora.slice(0, 10)})`);
  console.log(`Validação: ${validacao.length} (${validacao[0]?.data_hora.slice(0, 10)} até ${validacao[validacao.length - 1]?.data_hora.slice(0, 10)})`);
  console.log(`Teste final (RESERVADO): ${testeFinal.length} (a partir de ${testeFinal[0]?.data_hora.slice(0, 10)})\n`);

  for (const mercado of MERCADOS) {
    console.log(`\n=================== ${mercado.nome} ===================`);

    const probsTreino = treino.map((l) => l[mercado.chave]);
    const resultadosTreino = treino.map((l) => l[mercado.resultado]);
    const probsValidacao = validacao.map((l) => l[mercado.chave]);
    const resultadosValidacao = validacao.map((l) => l[mercado.resultado]);

    const calibrador = treinarPlatt(probsTreino, resultadosTreino);
    const probsCalibradas = probsValidacao.map((p) => aplicarPlatt(p, calibrador));
    const taxaConstanteGeral = resultadosTreino.reduce((s, r) => s + (r ? 1 : 0), 0) / resultadosTreino.length;
    const probsConstanteGeral = validacao.map(() => taxaConstanteGeral);

    console.log(`\nCalibrador: a=${calibrador.a.toFixed(4)}, b=${calibrador.b.toFixed(4)}`);
    console.log(`Taxa constante geral (treino): ${(taxaConstanteGeral * 100).toFixed(1)}%\n`);

    console.log('--- Conjunto de validação INTEIRO ---');
    avaliarConjunto(validacao, probsValidacao, resultadosValidacao, 'Bruto (Poisson)');
    avaliarConjunto(validacao, probsCalibradas, resultadosValidacao, 'Platt (calibrado)');
    avaliarConjunto(validacao, probsConstanteGeral, resultadosValidacao, 'Taxa constante geral');

    const bootGeral = bootstrapDiferencaBrierPorDia(validacao, probsCalibradas, probsConstanteGeral, resultadosValidacao);
    console.log(`  Bootstrap por dia (${bootGeral.diasUnicos} dias, semente fixa) -- Platt vs constante geral:`);
    console.log(`    diferença: ${bootGeral.diferencaMedia.toFixed(4)}  |  IC95%: [${bootGeral.intervalo95[0].toFixed(4)}, ${bootGeral.intervalo95[1].toFixed(4)}]  |  ${bootGeral.atravessaZero ? '⚠️  atravessa zero' : '✅ não atravessa zero'}`);

    console.log('\nCurva de calibração -- Platt (conjunto inteiro):');
    for (const c of curvaCalibracao(probsCalibradas, resultadosValidacao)) {
      if (c.n === 0) { console.log(`  ${c.faixa}: sem casos`); continue; }
      console.log(`  ${c.faixa}: previsto ${(c.probMedia * 100).toFixed(1)}% | real ${(c.taxaReal * 100).toFixed(1)}% | dif ${(c.diferenca * 100).toFixed(1)}pp (n=${c.n})`);
    }

    // ---------- Dentro do filtro de produção, com BASELINE POR COMPETIÇÃO ----------
    // (não mais uma taxa global misturando todas as ligas -- a produção já
    // usa uma taxa ESPECÍFICA por competição, com o mesmo mínimo de 60
    // casos que sempre exigimos. Comparar o Platt com uma taxa global seria
    // comparar com um concorrente mais fraco do que o que já está em
    // produção de verdade.)
    if (mercado.chave === 'p1X' || mercado.chave === 'pX2') {
      const MINIMO_CASOS_COMPETICAO = 60;

      const treinoFiltrado = treino.filter((l) => passaFiltroProducao(l, mercado.chave));

      // Taxa específica por competição, só onde o treino filtrado tem os
      // 60 casos mínimos que a produção também exige
      const treinoFiltradoPorComp = {};
      for (const l of treinoFiltrado) {
        if (!treinoFiltradoPorComp[l.competicao_nome]) treinoFiltradoPorComp[l.competicao_nome] = [];
        treinoFiltradoPorComp[l.competicao_nome].push(l);
      }
      const taxaPorCompeticao = {};
      for (const [nomeComp, linhas] of Object.entries(treinoFiltradoPorComp)) {
        if (linhas.length < MINIMO_CASOS_COMPETICAO) continue; // produção também não geraria taxa aqui
        taxaPorCompeticao[nomeComp] = linhas.reduce((s, l) => s + (l[mercado.resultado] ? 1 : 0), 0) / linhas.length;
      }

      // Validação: só entra na comparação quem tem taxa de competição
      // válida (senão a produção nem teria um baseline pra comparar)
      const validacaoFiltradaIdx = [];
      validacao.forEach((l, i) => {
        if (passaFiltroProducao(l, mercado.chave) && taxaPorCompeticao[l.competicao_nome] !== undefined) {
          validacaoFiltradaIdx.push(i);
        }
      });

      if (validacaoFiltradaIdx.length >= 20) {
        const linhasFiltro = validacaoFiltradaIdx.map((i) => validacao[i]);
        const probsCalibradasFiltro = validacaoFiltradaIdx.map((i) => probsCalibradas[i]);
        const resultadosFiltro = validacaoFiltradaIdx.map((i) => resultadosValidacao[i]);
        const probsBaselinePorComp = linhasFiltro.map((l) => taxaPorCompeticao[l.competicao_nome]);

        console.log(`\n--- Dentro do filtro de produção, baseline POR COMPETIÇÃO (n validação=${validacaoFiltradaIdx.length}) ---`);
        console.log(`  Competições com taxa própria válida (>=60 casos no treino filtrado): ${Object.keys(taxaPorCompeticao).length} de ${Object.keys(treinoFiltradoPorComp).length}`);
        avaliarConjunto(linhasFiltro, probsCalibradasFiltro, resultadosFiltro, 'Platt, dentro do filtro');
        avaliarConjunto(linhasFiltro, probsBaselinePorComp, resultadosFiltro, 'Taxa POR COMPETIÇÃO (a de produção)');

        const bootFiltro = bootstrapDiferencaBrierPorDia(linhasFiltro, probsCalibradasFiltro, probsBaselinePorComp, resultadosFiltro);
        console.log(`  Bootstrap por dia (${bootFiltro.diasUnicos} dias) -- Platt vs taxa por competição:`);
        console.log(`    diferença: ${bootFiltro.diferencaMedia.toFixed(4)}  |  IC95%: [${bootFiltro.intervalo95[0].toFixed(4)}, ${bootFiltro.intervalo95[1].toFixed(4)}]  |  ${bootFiltro.atravessaZero ? '⚠️  atravessa zero -- SEM evidência suficiente contra o baseline real de produção' : '✅ não atravessa zero -- real mesmo contra o baseline de produção'}`);

        // Quebra por competição, mostrando Platt vs baseline daquela
        // competição especificamente, lado a lado
        console.log(`\n  --- Por competição, dentro do filtro (Platt vs. taxa própria daquela liga) ---`);
        const porCompFiltro = {};
        linhasFiltro.forEach((l, idxLocal) => {
          if (!porCompFiltro[l.competicao_nome]) porCompFiltro[l.competicao_nome] = [];
          porCompFiltro[l.competicao_nome].push(idxLocal);
        });
        for (const [nomeComp, indicesLocais] of Object.entries(porCompFiltro)) {
          const nTreinoComp = treinoFiltradoPorComp[nomeComp]?.length ?? 0;
          if (indicesLocais.length < 20) {
            console.log(`    ${nomeComp.padEnd(28)} n_treino=${nTreinoComp}  n_val=${indicesLocais.length}  (amostra pequena demais na validação)`);
            continue;
          }
          const probsC = indicesLocais.map((i) => probsCalibradasFiltro[i]);
          const probsBaselineC = indicesLocais.map((i) => probsBaselinePorComp[i]);
          const resultadosC = indicesLocais.map((i) => resultadosFiltro[i]);
          const brierPlattC = brierScore(probsC, resultadosC);
          const brierBaselineC = brierScore(probsBaselineC, resultadosC);
          const aucC = calcularAUC(probsC, resultadosC);
          console.log(`    ${nomeComp.padEnd(28)} n_treino=${nTreinoComp}  n_val=${indicesLocais.length}  Brier Platt=${brierPlattC.toFixed(4)}  Brier taxa própria=${brierBaselineC.toFixed(4)}  dif=${(brierBaselineC - brierPlattC).toFixed(4)}  AUC=${aucC !== null ? aucC.toFixed(3) : 'n/a'}`);
        }

        const competicoesSemTaxaValida = Object.keys(treinoFiltradoPorComp).filter((c) => taxaPorCompeticao[c] === undefined);
        if (competicoesSemTaxaValida.length > 0) {
          console.log(`\n  (Excluídas dessa comparação, por não terem 60 casos filtrados no treino -- produção também não geraria sinal lá: ${competicoesSemTaxaValida.join(', ')})`);
        }
      } else {
        console.log(`\n--- Filtro de produção com baseline por competição: poucos casos válidos ainda (n=${validacaoFiltradaIdx.length}) -- pulando ---`);
      }

      // ---------- Quebra por competição, no conjunto de validação INTEIRO ----------
      // (complementa a de cima -- essa mostra discriminação/Brier em cada
      // liga usando TODOS os jogos, não só os que passam no filtro)
      console.log(`\n--- Por competição (validação inteira, não só o filtro) ---`);
      const porCompeticao = {};
      validacao.forEach((l, i) => {
        if (!porCompeticao[l.competicao_nome]) porCompeticao[l.competicao_nome] = { indices: [] };
        porCompeticao[l.competicao_nome].indices.push(i);
      });
      for (const [nomeComp, dados] of Object.entries(porCompeticao)) {
        if (dados.indices.length < 30) continue;
        const probsComp = dados.indices.map((i) => probsCalibradas[i]);
        const resultadosComp = dados.indices.map((i) => resultadosValidacao[i]);
        const brierComp = brierScore(probsComp, resultadosComp);
        const aucComp = calcularAUC(probsComp, resultadosComp);
        const taxaRealComp = resultadosComp.reduce((s, r) => s + (r ? 1 : 0), 0) / resultadosComp.length;
        console.log(`  ${nomeComp.padEnd(28)} n=${dados.indices.length}  Brier=${brierComp.toFixed(4)}  AUC=${aucComp !== null ? aucComp.toFixed(3) : 'n/a'}  taxa real=${(taxaRealComp * 100).toFixed(1)}%`);
      }
    }
  }

  console.log('\n\n⚠️  Lembrete: o período de teste final NÃO foi avaliado aqui -- fica reservado.');
}

main();
