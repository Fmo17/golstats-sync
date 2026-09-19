/**
 * scripts/lib/metricas.js
 *
 * Métricas pra avaliar se uma probabilidade está bem calibrada -- não é
 * sobre "acertou ou errou" (isso mede regra, não probabilidade), é sobre
 * "quando o modelo disse 70%, isso realmente aconteceu perto de 70% das
 * vezes?".
 */

/**
 * Brier score -- erro quadrático médio entre a probabilidade prevista e o
 * resultado real (0 ou 1). Quanto MENOR, melhor. Uma previsão perfeita dá 0;
 * "sempre 50%" dá 0.25; previsões confiantes e erradas são punidas mais.
 */
export function brierScore(probabilidades, resultados) {
  let soma = 0;
  for (let i = 0; i < probabilidades.length; i++) {
    const y = resultados[i] ? 1 : 0;
    soma += Math.pow(probabilidades[i] - y, 2);
  }
  return soma / probabilidades.length;
}

/**
 * Log loss -- também menor é melhor, mas pune com MUITO mais força uma
 * previsão confiante e errada (ex: dizer 99% e dar errado) do que o Brier.
 */
export function logLoss(probabilidades, resultados, epsilon = 1e-15) {
  let soma = 0;
  for (let i = 0; i < probabilidades.length; i++) {
    const y = resultados[i] ? 1 : 0;
    const p = Math.min(Math.max(probabilidades[i], epsilon), 1 - epsilon);
    soma += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return soma / probabilidades.length;
}

/**
 * Curva de calibração -- separa as previsões em faixas (ex: 50-60%, 60-70%)
 * e compara a probabilidade MÉDIA que o modelo deu naquela faixa com a taxa
 * REAL de acerto observada. Se estiver bem calibrado, os dois números devem
 * ficar próximos em toda faixa -- não só na média geral.
 */
/**
 * AUC (área sob a curva ROC) -- mede se o modelo consegue DIFERENCIAR jogos
 * (dar probabilidade mais alta pros que realmente aconteceram), separado de
 * "a probabilidade está calibrada". Um modelo pode estar bem calibrado na
 * média e ainda assim ter AUC ruim (ex: prever sempre a mesma taxa
 * constante "acerta" a calibração média, mas tem AUC = 0.5, ou seja,
 * nenhuma capacidade de separar jogos).
 *
 *   0.5 = não separa nada (equivale a chute aleatório)
 *   1.0 = separa perfeitamente
 */
export function calcularAUC(probabilidades, resultados) {
  const positivos = [];
  const negativos = [];
  for (let i = 0; i < probabilidades.length; i++) {
    if (resultados[i]) positivos.push(probabilidades[i]);
    else negativos.push(probabilidades[i]);
  }
  if (positivos.length === 0 || negativos.length === 0) return null;

  let concordantes = 0, empates = 0;
  for (const p of positivos) {
    for (const n of negativos) {
      if (p > n) concordantes++;
      else if (p === n) empates++;
    }
  }
  return (concordantes + empates * 0.5) / (positivos.length * negativos.length);
}

/**
 * Bootstrap pareado -- reamostra o conjunto de validação (com reposição)
 * muitas vezes, recalcula "Brier do candidato A menos Brier do candidato B"
 * em cada reamostragem, e devolve o intervalo de 95% dessa diferença. Se
 * esse intervalo atravessar zero, não há evidência suficiente de que A é
 * realmente melhor que B -- pode ser só variação de amostra.
 */
export function bootstrapDiferencaBrier(probsA, probsB, resultados, repeticoes = 2000) {
  const n = probsA.length;
  const diferencas = [];

  for (let r = 0; r < repeticoes; r++) {
    let somaA = 0, somaB = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n); // reamostragem com reposição
      const y = resultados[idx] ? 1 : 0;
      somaA += Math.pow(probsA[idx] - y, 2);
      somaB += Math.pow(probsB[idx] - y, 2);
    }
    diferencas.push(somaA / n - somaB / n);
  }

  diferencas.sort((a, b) => a - b);
  const p2_5 = diferencas[Math.floor(repeticoes * 0.025)];
  const p97_5 = diferencas[Math.floor(repeticoes * 0.975)];

  return {
    diferencaMedia: diferencas.reduce((s, d) => s + d, 0) / repeticoes,
    intervalo95: [p2_5, p97_5],
    atravessaZero: p2_5 <= 0 && p97_5 >= 0,
  };
}

/**
 * Curva de calibração -- separa as previsões em faixas (ex: 50-60%, 60-70%)
 * e compara a probabilidade MÉDIA que o modelo deu naquela faixa com a taxa
 * REAL de acerto observada. Se estiver bem calibrado, os dois números devem
 * ficar próximos em toda faixa -- não só na média geral.
 */
export function curvaCalibracao(probabilidades, resultados, faixas = null) {
  const faixasPadrao = [
    [0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.001],
  ];
  const faixasUsadas = faixas || faixasPadrao;

  return faixasUsadas.map(([min, max]) => {
    const indices = [];
    for (let i = 0; i < probabilidades.length; i++) {
      if (probabilidades[i] >= min && probabilidades[i] < max) indices.push(i);
    }
    if (indices.length === 0) {
      return { faixa: `${(min * 100).toFixed(0)}-${(max * 100).toFixed(0)}%`, n: 0, probMedia: null, taxaReal: null, diferenca: null };
    }
    const probMedia = indices.reduce((s, i) => s + probabilidades[i], 0) / indices.length;
    const taxaReal = indices.reduce((s, i) => s + (resultados[i] ? 1 : 0), 0) / indices.length;
    return {
      faixa: `${(min * 100).toFixed(0)}-${(max * 100).toFixed(0)}%`,
      n: indices.length,
      probMedia,
      taxaReal,
      diferenca: probMedia - taxaReal,
    };
  });
}
