/**
 * scripts/lib/calibracao.js
 *
 * Platt scaling -- calibrador de 2 parâmetros (a, b) que ajusta a
 * probabilidade bruta do Poisson pra ficar mais próxima da frequência real
 * observada:
 *
 *   pCalibrada = sigmoid(a + b * logit(pBruta))
 *
 * Escolhido em vez de calibração isotônica porque, com ~500-2000 casos por
 * mercado, um calibrador de 2 parâmetros é muito mais seguro que um método
 * não-paramétrico (que precisa de bem mais dado pra não sobreajustar).
 */

export function logit(p) {
  const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(clamped / (1 - clamped));
}

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Treina (a, b) por gradiente descendente, minimizando log loss --
 * exatamente uma regressão logística com 1 variável de entrada (o logit da
 * probabilidade bruta).
 */
export function treinarPlatt(probabilidadesBrutas, resultadosReais, opcoes = {}) {
  const taxaAprendizado = opcoes.taxaAprendizado ?? 0.05;
  const epocas = opcoes.epocas ?? 3000;
  const n = probabilidadesBrutas.length;

  const xs = probabilidadesBrutas.map(logit);

  // Início em (a=0, b=1) -- equivale a "não mudar nada" (pCalibrada = pBruta)
  let a = 0, b = 1;

  for (let epoca = 0; epoca < epocas; epoca++) {
    let gradA = 0, gradB = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(a + b * xs[i]);
      const y = resultadosReais[i] ? 1 : 0;
      const erro = p - y;
      gradA += erro;
      gradB += erro * xs[i];
    }
    a -= taxaAprendizado * (gradA / n);
    b -= taxaAprendizado * (gradB / n);
  }

  return { a, b, n };
}

export function aplicarPlatt(probabilidadeBruta, calibrador) {
  return sigmoid(calibrador.a + calibrador.b * logit(probabilidadeBruta));
}
