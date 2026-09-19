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

    // ---------- Dentro do filtro de produção, com BASELINE CORRIGIDO ----------
    if (mercado.chave === 'p1X' || mercado.chave === 'pX2') {
      const treinoFiltrado = treino.filter((l) => passaFiltroProducao(l, mercado.chave));
      const validacaoFiltradaIdx = [];
      validacao.forEach((l, i) => { if (passaFiltroProducao(l, mercado.chave)) validacaoFiltradaIdx.push(i); });

      if (treinoFiltrado.length >= 20 && validacaoFiltradaIdx.length >= 20) {
        const taxaConstanteFiltro = treinoFiltrado.reduce((s, l) => s + (l[mercado.resultado] ? 1 : 0), 0) / treinoFiltrado.length;

        const linhasFiltro = validacaoFiltradaIdx.map((i) => validacao[i]);
        const probsCalibradasFiltro = validacaoFiltradaIdx.map((i) => probsCalibradas[i]);
        const resultadosFiltro = validacaoFiltradaIdx.map((i) => resultadosValidacao[i]);
        const probsConstanteFiltro = validacaoFiltradaIdx.map(() => taxaConstanteFiltro);

        console.log(`\n--- Dentro do filtro de produção (n treino filtrado=${treinoFiltrado.length}, n validação filtrada=${validacaoFiltradaIdx.length}) ---`);
        console.log(`  Taxa constante DESSE filtro específico (treino filtrado): ${(taxaConstanteFiltro * 100).toFixed(1)}%  (era ${(taxaConstanteGeral * 100).toFixed(1)}% geral -- essa é a comparação justa)`);
        avaliarConjunto(linhasFiltro, probsCalibradasFiltro, resultadosFiltro, 'Platt, dentro do filtro');
        avaliarConjunto(linhasFiltro, probsConstanteFiltro, resultadosFiltro, 'Constante DO FILTRO (correta)');

        const bootFiltro = bootstrapDiferencaBrierPorDia(linhasFiltro, probsCalibradasFiltro, probsConstanteFiltro, resultadosFiltro);
        console.log(`  Bootstrap por dia (${bootFiltro.diasUnicos} dias) -- Platt vs constante DO FILTRO:`);
        console.log(`    diferença: ${bootFiltro.diferencaMedia.toFixed(4)}  |  IC95%: [${bootFiltro.intervalo95[0].toFixed(4)}, ${bootFiltro.intervalo95[1].toFixed(4)}]  |  ${bootFiltro.atravessaZero ? '⚠️  atravessa zero -- SEM evidência suficiente dentro do filtro' : '✅ não atravessa zero -- real mesmo dentro do filtro'}`);

        // Quebra por competição, ESPECIFICAMENTE dentro do filtro (não o
        // conjunto inteiro) -- pra saber se a vantagem dentro do filtro
        // também não vem de uma liga só
        console.log(`\n  --- Por competição, DENTRO do filtro ---`);
        const porCompFiltro = {};
        linhasFiltro.forEach((l, idxLocal) => {
          if (!porCompFiltro[l.competicao_nome]) porCompFiltro[l.competicao_nome] = [];
          porCompFiltro[l.competicao_nome].push(idxLocal);
        });
        for (const [nomeComp, indicesLocais] of Object.entries(porCompFiltro)) {
          if (indicesLocais.length < 20) {
            console.log(`    ${nomeComp.padEnd(28)} n=${indicesLocais.length}  (amostra pequena demais dentro do filtro)`);
            continue;
          }
          const probsC = indicesLocais.map((i) => probsCalibradasFiltro[i]);
          const resultadosC = indicesLocais.map((i) => resultadosFiltro[i]);
          const brierC = brierScore(probsC, resultadosC);
          const aucC = calcularAUC(probsC, resultadosC);
          const taxaRealC = resultadosC.reduce((s, r) => s + (r ? 1 : 0), 0) / resultadosC.length;
          console.log(`    ${nomeComp.padEnd(28)} n=${indicesLocais.length}  Brier=${brierC.toFixed(4)}  AUC=${aucC !== null ? aucC.toFixed(3) : 'n/a'}  taxa real=${(taxaRealC * 100).toFixed(1)}%`);
        }
      } else {
        console.log(`\n--- Filtro de produção tem poucos casos ainda (treino=${treinoFiltrado.length}, validação=${validacaoFiltradaIdx.length}) -- pulando ---`);
      }

      // ---------- Quebra por competição ----------
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
