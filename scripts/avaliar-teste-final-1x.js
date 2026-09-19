/**
 * scripts/avaliar-teste-final-1x.js
 *
 * TESTE FINAL BLOQUEADO -- avalia SOMENTE o mercado Dupla 1X, no período de
 * teste reservado (nunca consultado até agora), usando as regras
 * congeladas em conjunto com o ChatGPT.
 *
 * ==================================================================
 * ESTE SCRIPT SÓ DEVE SER RODADO UMA ÚNICA VEZ, depois de commitado e
 * revisado. Rodar de novo depois de ver o resultado, ajustando qualquer
 * coisa, invalida a garantia de "teste intocado" -- que é o propósito
 * inteiro desse processo.
 * ==================================================================
 *
 * Regras congeladas (não mudam depois de commitado este arquivo):
 *  - Mercado: SOMENTE Dupla 1X (nenhum outro mercado é avaliado ou impresso)
 *  - Filtro de produção: p1X > 0.65
 *  - Só competições com >= 60 casos filtrados no TREINO
 *  - Calibrador Platt treinado exclusivamente no treino (60% mais antigo)
 *  - Baseline (taxa histórica) por competição, calculado exclusivamente no treino
 *  - Avalia exclusivamente o TESTE FINAL (últimos 20% do dataset, por
 *    fronteira de dia) -- nunca consultado em nenhuma etapa anterior
 *  - Bootstrap por dia, 2000 repetições, semente fixa (20260919)
 *
 * Critério de aprovação (definido ANTES de rodar, não muda com o resultado):
 *  PRINCIPAL: Brier do Platt < Brier do baseline por competição, E o
 *             intervalo de 95% do bootstrap fica INTEIRAMENTE abaixo de zero
 *  SECUNDÁRIOS: log loss do Platt não piora; AUC > 0.50; resultado não
 *               concentrado numa única competição
 *
 * Protocolo: antes de rodar, confirme o hash SHA256 do dataset com:
 *   certutil -hashfile experimentos\dataset-calibracao.json SHA256
 * Esperado (conforme registrado em 2026-09): 13.669 partidas totais,
 * treino=8.217, validação=2.733, teste final=2.719, início do teste em
 * 19/01/2026. Se os números não baterem, o dataset foi alterado -- pare e
 * verifique antes de continuar.
 *
 * Uso (rodar só depois de commitado):
 *   node scripts/avaliar-teste-final-1x.js
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { treinarPlatt, aplicarPlatt } from './lib/calibracao.js';
import { brierScore, logLoss, calcularAUC, bootstrapDiferencaBrierPorDia } from './lib/metricas.js';

const LIMIAR_1X_PRODUCAO = 0.65;
const MINIMO_CASOS_COMPETICAO = 60;

// Hash SHA256 do dataset no momento em que o protocolo foi congelado --
// obtido com: certutil -hashfile experimentos\dataset-calibracao.json SHA256
// Se o arquivo mudar UM BYTE que seja, o hash muda, e o teste é cancelado.
const HASH_ESPERADO_DATASET = 'b5eece395054deb68762540ca0417127773d92c5b83953e5edd4e31ab7102b1e';

function ajustarCorteParaFronteiraDia(dataset, indiceAlvo) {
  let i = indiceAlvo;
  const diaDoIndice = (idx) => dataset[idx].data_hora.slice(0, 10);
  while (i < dataset.length && i > 0 && diaDoIndice(i) === diaDoIndice(i - 1)) i++;
  return Math.min(i, dataset.length);
}

function main() {
  const caminho = './experimentos/dataset-calibracao.json';

  // ---------- Trava 1: hash do arquivo, verificado ANTES de sequer ler o JSON ----------
  const conteudoDataset = readFileSync(caminho);
  const hashAtual = createHash('sha256').update(conteudoDataset).digest('hex');

  if (HASH_ESPERADO_DATASET === 'PENDENTE_AGUARDANDO_CERTUTIL') {
    console.error('❌ HASH_ESPERADO_DATASET ainda não foi preenchido -- rode certutil e preencha antes de continuar.');
    process.exitCode = 1;
    return;
  }

  if (hashAtual !== HASH_ESPERADO_DATASET) {
    console.error('❌ TESTE FINAL CANCELADO -- o hash do dataset não bate com o protocolo congelado.');
    console.error(`   Esperado: ${HASH_ESPERADO_DATASET}`);
    console.error(`   Atual:    ${hashAtual}`);
    console.error('   O arquivo foi alterado desde que o protocolo foi fechado. Não confie em nenhum resultado abaixo.');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ Hash do dataset conferido -- bate exatamente com o protocolo congelado.\n`);

  const dataset = JSON.parse(conteudoDataset.toString('utf-8'));

  const corteTreino = ajustarCorteParaFronteiraDia(dataset, Math.floor(dataset.length * 0.6));
  const corteValidacao = ajustarCorteParaFronteiraDia(dataset, Math.floor(dataset.length * 0.8));

  const treino = dataset.slice(0, corteTreino);
  const testeFinal = dataset.slice(corteValidacao);

  console.log('=== TESTE FINAL BLOQUEADO -- Dupla 1X (avaliação única) ===\n');
  console.log(`Dataset total: ${dataset.length} partidas`);
  console.log(`Treino: ${treino.length} (até ${treino[treino.length - 1]?.data_hora.slice(0, 10)})`);
  console.log(`Teste final: ${testeFinal.length} (a partir de ${testeFinal[0]?.data_hora.slice(0, 10)})\n`);

  // ---------- Trava 2: tamanhos precisam bater EXATAMENTE, senão CANCELA de verdade ----------
  if (dataset.length !== 13669 || treino.length !== 8217 || testeFinal.length !== 2719) {
    console.error('❌ TESTE FINAL CANCELADO -- os tamanhos não batem com o protocolo registrado (13.669 / 8.217 / 2.719).');
    console.error('   O dataset foi alterado. Não confie em nenhum resultado abaixo -- ele não foi calculado.');
    process.exitCode = 1;
    return;
  }

  // ---------- Calibrador: treinado EXCLUSIVAMENTE no treino ----------
  const probsTreino = treino.map((l) => l.p1X);
  const resultadosTreino = treino.map((l) => l.resultado_1X);
  const calibrador = treinarPlatt(probsTreino, resultadosTreino);
  console.log(`Calibrador (treinado só no treino): a=${calibrador.a.toFixed(4)}, b=${calibrador.b.toFixed(4)}\n`);

  // ---------- Baseline por competição: calculado EXCLUSIVAMENTE no treino ----------
  const treinoFiltrado = treino.filter((l) => l.p1X > LIMIAR_1X_PRODUCAO);
  const treinoFiltradoPorComp = {};
  for (const l of treinoFiltrado) {
    if (!treinoFiltradoPorComp[l.competicao_nome]) treinoFiltradoPorComp[l.competicao_nome] = [];
    treinoFiltradoPorComp[l.competicao_nome].push(l);
  }
  const taxaPorCompeticao = {};
  for (const [nomeComp, linhas] of Object.entries(treinoFiltradoPorComp)) {
    if (linhas.length < MINIMO_CASOS_COMPETICAO) continue;
    taxaPorCompeticao[nomeComp] = linhas.reduce((s, l) => s + (l.resultado_1X ? 1 : 0), 0) / linhas.length;
  }

  console.log('Baseline por competição (treino, mínimo 60 casos filtrados):');
  for (const [nome, taxa] of Object.entries(taxaPorCompeticao)) {
    console.log(`  ${nome}: ${(taxa * 100).toFixed(1)}% (n=${treinoFiltradoPorComp[nome].length})`);
  }
  console.log('');

  // ---------- Aplica no TESTE FINAL -- filtro de produção + baseline válido ----------
  const testeFiltradoIdx = [];
  testeFinal.forEach((l, i) => {
    if (l.p1X > LIMIAR_1X_PRODUCAO && taxaPorCompeticao[l.competicao_nome] !== undefined) {
      testeFiltradoIdx.push(i);
    }
  });

  const linhasTeste = testeFiltradoIdx.map((i) => testeFinal[i]);
  const probsBrutas = linhasTeste.map((l) => l.p1X);
  const probsCalibradas = probsBrutas.map((p) => aplicarPlatt(p, calibrador));
  const probsBaseline = linhasTeste.map((l) => taxaPorCompeticao[l.competicao_nome]);
  const resultados = linhasTeste.map((l) => l.resultado_1X);

  console.log(`=== RESULTADO NO TESTE FINAL (n=${linhasTeste.length}, nunca consultado antes) ===\n`);

  const brierPlatt = brierScore(probsCalibradas, resultados);
  const brierBaseline = brierScore(probsBaseline, resultados);
  const llPlatt = logLoss(probsCalibradas, resultados);
  const llBaseline = logLoss(probsBaseline, resultados);
  const aucPlatt = calcularAUC(probsCalibradas, resultados);

  console.log(`Brier Platt:       ${brierPlatt.toFixed(4)}`);
  console.log(`Brier Baseline:    ${brierBaseline.toFixed(4)}`);
  console.log(`Log loss Platt:    ${llPlatt.toFixed(4)}`);
  console.log(`Log loss Baseline: ${llBaseline.toFixed(4)}`);
  console.log(`AUC Platt: ${aucPlatt !== null ? aucPlatt.toFixed(3) : 'n/a'}\n`);

  const boot = bootstrapDiferencaBrierPorDia(linhasTeste, probsCalibradas, probsBaseline, resultados);
  console.log(`Bootstrap por dia (${boot.diasUnicos} dias, semente fixa 20260919) -- Platt vs baseline:`);
  console.log(`  diferença: ${boot.diferencaMedia.toFixed(4)}  |  IC95%: [${boot.intervalo95[0].toFixed(4)}, ${boot.intervalo95[1].toFixed(4)}]`);
  console.log(`  ${boot.atravessaZero ? '⚠️  atravessa zero' : '✅ não atravessa zero'}\n`);

  console.log('--- Por competição, no teste final ---');
  const porComp = {};
  linhasTeste.forEach((l, i) => {
    if (!porComp[l.competicao_nome]) porComp[l.competicao_nome] = [];
    porComp[l.competicao_nome].push(i);
  });
  let competicoesAvaliadas = 0;
  let competicoesOndePlattVenceu = 0;
  for (const [nome, indices] of Object.entries(porComp)) {
    if (indices.length < 10) { console.log(`  ${nome}: n=${indices.length} (amostra pequena)`); continue; }
    const pC = indices.map((i) => probsCalibradas[i]);
    const pB = indices.map((i) => probsBaseline[i]);
    const rC = indices.map((i) => resultados[i]);
    const brierCComp = brierScore(pC, rC);
    const brierBComp = brierScore(pB, rC);
    competicoesAvaliadas++;
    if (brierCComp < brierBComp) competicoesOndePlattVenceu++;
    console.log(`  ${nome.padEnd(28)} n=${indices.length}  Brier Platt=${brierCComp.toFixed(4)}  Brier baseline=${brierBComp.toFixed(4)}  dif=${(brierBComp - brierCComp).toFixed(4)}  ${brierCComp < brierBComp ? '(Platt venceu)' : '(baseline venceu)'}`);
  }
  console.log(`\n  Platt venceu em ${competicoesOndePlattVenceu} de ${competicoesAvaliadas} competições avaliadas (informativo -- não bloqueia sozinho a aprovação).`);

  console.log('\n\n=== VEREDITO (critérios definidos ANTES desse teste, sem ajuste posterior) ===');
  // Critério direto e explícito: o limite SUPERIOR do intervalo precisa
  // estar abaixo de zero -- "não atravessa zero" sozinho também aceitaria
  // (em teoria) um intervalo inteiramente POSITIVO, que seria o oposto do
  // que queremos.
  const criterioPrincipal = brierPlatt < brierBaseline && boot.intervalo95[1] < 0;
  const criterioLogLoss = llPlatt <= llBaseline;
  const criterioAUC = aucPlatt !== null && aucPlatt > 0.5;

  console.log(`Critério principal (Brier menor E IC95% inteiramente abaixo de zero): ${criterioPrincipal ? '✅ PASSOU' : '❌ NÃO PASSOU'}`);
  console.log(`Log loss não piorou: ${criterioLogLoss ? '✅ sim' : '❌ não'}`);
  console.log(`AUC > 0.50: ${criterioAUC ? '✅ sim' : '❌ não'}`);
  console.log(
    `\n${criterioPrincipal ? 'APROVADO -- pode seguir pra próxima etapa (modo sombra em produção, sem afetar usuários ainda)' : 'NÃO APROVADO -- Platt não deve substituir a taxa por competição pra Dupla 1X'}`
  );
}

main();
