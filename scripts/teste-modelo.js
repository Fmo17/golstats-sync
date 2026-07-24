// Teste rápido e isolado da matemática do modelo, com dados fictícios
// (não toca no Supabase -- só valida a lógica de cálculo).

function fatorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poisson(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fatorial(k);
}

function preverPartida(golsEsperadosCasa, golsEsperadosFora, maxGols = 8) {
  const matriz = [];
  for (let gc = 0; gc <= maxGols; gc++) {
    matriz[gc] = [];
    for (let gf = 0; gf <= maxGols; gf++) {
      matriz[gc][gf] = poisson(gc, golsEsperadosCasa) * poisson(gf, golsEsperadosFora);
    }
  }

  let probVitoriaCasa = 0, probEmpate = 0, probVitoriaFora = 0, probOver25 = 0, probAmbasMarcam = 0, somaTotal = 0;

  for (let gc = 0; gc <= maxGols; gc++) {
    for (let gf = 0; gf <= maxGols; gf++) {
      const p = matriz[gc][gf];
      somaTotal += p;
      if (gc > gf) probVitoriaCasa += p;
      else if (gc === gf) probEmpate += p;
      else probVitoriaFora += p;
      if (gc + gf > 2.5) probOver25 += p;
      if (gc >= 1 && gf >= 1) probAmbasMarcam += p;
    }
  }

  return { probVitoriaCasa, probEmpate, probVitoriaFora, probOver25, probAmbasMarcam, somaTotal };
}

console.log('=== Teste 1: times equilibrados (1.4 x 1.1 gols esperados) ===');
console.log(preverPartida(1.4, 1.1));

console.log('\n=== Teste 2: favorito forte em casa (2.5 x 0.8 gols esperados) ===');
console.log(preverPartida(2.5, 0.8));

console.log('\n=== Teste 3: soma das probabilidades deve ficar perto de 1.0 (verifica truncamento em 8 gols) ===');
const r3 = preverPartida(1.5, 1.2);
console.log('Soma total da matriz:', r3.somaTotal.toFixed(4), '(esperado: bem próximo de 1.0)');
console.log('Soma 1x2:', (r3.probVitoriaCasa + r3.probEmpate + r3.probVitoriaFora).toFixed(4));

console.log('\n=== Teste 4: sanity check -- time muito mais forte deve ter probVitoria bem mais alta ===');
const r4 = preverPartida(3.0, 0.5);
console.log('Prob vitória casa:', (r4.probVitoriaCasa * 100).toFixed(1) + '%');
console.log('Prob vitória fora:', (r4.probVitoriaFora * 100).toFixed(1) + '%');
console.log(r4.probVitoriaCasa > r4.probVitoriaFora ? 'PASSOU (casa favorita corretamente)' : 'FALHOU');
