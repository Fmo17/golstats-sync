/**
 * testar-faixa-minima-gols.js
 *
 * Testa a ideia: quando ataque e defesa DISCORDAM da faixa, em vez de
 * descartar o jogo (consenso rígido) ou misturar numa média, usa a faixa
 * MAIS BAIXA (mais conservadora) entre as duas -- ex: ataque prevê 3+,
 * defesa prevê 2+ -> usa 2+. Quando os 2 concordam, usa a faixa normal.
 *
 * Também roda um TESTE ESTATÍSTICO FORMAL (comparação de proporções, com
 * z-score) contra o método já em produção (ataque sozinho, janela 10),
 * pra saber se a diferença encontrada é real ou só variação de amostra.
 *
 * Uso:
 *   node scripts/testar-faixa-minima-gols.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MINIMO_JOGOS_TIME = 3;
const MINIMO_JOGOS_LIGA = 10;
const ORDEM_FAIXA = { '1mais': 1, '2mais': 2, '3mais': 3 };

function calcularDiff(partidasAnteriores, timeCasaId, timeForaId, tipo) {
  const jogosMandante = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId);
  const jogosVisitante = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId);
  if (jogosMandante.length < MINIMO_JOGOS_TIME || jogosVisitante.length < MINIMO_JOGOS_TIME) return null;

  const campoMandante = tipo === 'ataque' ? 'gols_casa' : 'gols_fora';
  const campoVisitante = tipo === 'ataque' ? 'gols_fora' : 'gols_casa';
  const mediaMandante = jogosMandante.reduce((s, p) => s + p[campoMandante], 0) / jogosMandante.length;
  const mediaVisitante = jogosVisitante.reduce((s, p) => s + p[campoVisitante], 0) / jogosVisitante.length;

  if (partidasAnteriores.length < MINIMO_JOGOS_LIGA) return null;
  const mediaLigaTotal = partidasAnteriores.reduce((s, p) => s + p.gols_casa + p.gols_fora, 0) / partidasAnteriores.length;
  const mediaLiga = mediaLigaTotal / 2;
  const mediaConfronto = (mediaMandante + mediaVisitante) / 2;
  return ((mediaConfronto - mediaLiga) / mediaLiga) * 100;
}

function classificarFaixa(d) {
  if (d > 30) return '3mais';
  if (d > 10) return '2mais';
  if (d >= -10) return '1mais';
  return null;
}
function bateuFaixa(faixa, golsTotais) {
  if (faixa === '3mais') return golsTotais >= 3;
  if (faixa === '2mais') return golsTotais >= 2;
  if (faixa === '1mais') return golsTotais >= 1;
  return null;
}

// Teste estatístico formal: compara 2 proporções (ex: 856/1516 vs 900/1600)
// e diz se a diferença é maior do que se esperaria só por acaso.
function testeDeProporcao(acertos1, total1, acertos2, total2) {
  const p1 = acertos1 / total1;
  const p2 = acertos2 / total2;
  const pPooled = (acertos1 + acertos2) / (total1 + total2);
  const erroPadrao = Math.sqrt(pPooled * (1 - pPooled) * (1 / total1 + 1 / total2));
  const z = (p1 - p2) / erroPadrao;
  const zAbsoluto = Math.abs(z);

  // Aproximação padrão do p-valor (bicaudal) a partir do z-score
  const pValor = 2 * (1 - aproximarCDFNormal(zAbsoluto));

  let significancia;
  if (zAbsoluto >= 2.576) significancia = '99% de confiança';
  else if (zAbsoluto >= 1.96) significancia = '95% de confiança';
  else if (zAbsoluto >= 1.645) significancia = '90% de confiança (fraco)';
  else significancia = 'NÃO significativo -- pode ser só ruído de amostra';

  return { p1, p2, diferenca: p1 - p2, z, pValor, significancia };
}

function aproximarCDFNormal(z) {
  // Aproximação numérica padrão da função de distribuição acumulada normal
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - prob;
}

async function main() {
  console.log('Pré-calculando ataque e defesa (temporada inteira) pra todo o histórico...\n');

  const { data: competicoes } = await supabase.from('competicoes').select('id, nome').eq('ativa', true);

  const resultadosFaixaMinima = { '3mais': { total: 0, acertos: 0 }, '2mais': { total: 0, acertos: 0 }, '1mais': { total: 0, acertos: 0 } };
  let totalComOsDois = 0;
  let totalConcordam = 0;
  let totalDiscordam = 0;

  for (const comp of competicoes) {
    const { data: partidas } = await supabase
      .from('partidas')
      .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
      .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
      .order('data_hora', { ascending: true });
    if (!partidas || partidas.length < 40) continue;

    for (let i = 0; i < partidas.length; i++) {
      const partida = partidas[i];
      const historicoAntes = partidas.slice(0, i);

      const diffAtaque = calcularDiff(historicoAntes, partida.time_casa_id, partida.time_fora_id, 'ataque');
      const diffDefesa = calcularDiff(historicoAntes, partida.time_casa_id, partida.time_fora_id, 'defesa');
      if (diffAtaque === null || diffDefesa === null) continue;

      const faixaAtaque = classificarFaixa(diffAtaque);
      const faixaDefesa = classificarFaixa(diffDefesa);
      if (!faixaAtaque || !faixaDefesa) continue;

      totalComOsDois++;
      if (faixaAtaque === faixaDefesa) totalConcordam++; else totalDiscordam++;

      // A REGRA NOVA: pega a faixa mais baixa (mais conservadora) das 2
      const faixaFinal = ORDEM_FAIXA[faixaAtaque] <= ORDEM_FAIXA[faixaDefesa] ? faixaAtaque : faixaDefesa;

      const golsTotais = partida.gols_casa + partida.gols_fora;
      const acertou = bateuFaixa(faixaFinal, golsTotais);

      resultadosFaixaMinima[faixaFinal].total++;
      if (acertou) resultadosFaixaMinima[faixaFinal].acertos++;
    }
  }

  console.log('=== RESULTADO: faixa mínima (mais conservadora) entre ataque e defesa ===\n');
  for (const [faixaNome, dados] of Object.entries(resultadosFaixaMinima)) {
    if (dados.total === 0) { console.log(`  ${faixaNome}: sem casos`); continue; }
    const taxa = (dados.acertos / dados.total) * 100;
    console.log(`  ${faixaNome}: ${dados.acertos}/${dados.total} (${taxa.toFixed(1)}%)`);
  }
  const totalSinais = Object.values(resultadosFaixaMinima).reduce((s, r) => s + r.total, 0);
  console.log(`\n  Jogos com os 2 indicadores: ${totalComOsDois}`);
  console.log(`  Concordam: ${totalConcordam} (${((totalConcordam / totalComOsDois) * 100).toFixed(1)}%)  |  Discordam: ${totalDiscordam} (${((totalDiscordam / totalComOsDois) * 100).toFixed(1)}%)`);
  console.log(`  Volume final (todos geram sinal, concordando ou não): ${totalSinais} (${((totalSinais / totalComOsDois) * 100).toFixed(1)}%)`);

  // ---------- Comparação estatística formal contra o método em produção ----------
  // Números do método já em produção (ataque sozinho, janela 10) --
  // resultado do teste "testar-ataque-sozinho-gols.js" rodado antes
  const producaoAtual = {
    '3mais': { acertos: 856, total: 1516 },
    '2mais': { acertos: 1517, total: 1992 },
    '1mais': { acertos: 2582, total: 2800 },
  };

  console.log('\n\n=== TESTE ESTATÍSTICO FORMAL: faixa mínima vs. método em produção ===\n');
  for (const faixaNome of ['3mais', '2mais', '1mais']) {
    const novo = resultadosFaixaMinima[faixaNome];
    const antigo = producaoAtual[faixaNome];
    if (novo.total === 0) continue;

    const teste = testeDeProporcao(novo.acertos, novo.total, antigo.acertos, antigo.total);
    console.log(`${faixaNome}:`);
    console.log(`  Faixa mínima: ${(teste.p1 * 100).toFixed(1)}% (${novo.acertos}/${novo.total})`);
    console.log(`  Produção atual: ${(teste.p2 * 100).toFixed(1)}% (${antigo.acertos}/${antigo.total})`);
    console.log(`  Diferença: ${(teste.diferenca * 100).toFixed(1)} pontos percentuais`);
    console.log(`  z-score: ${teste.z.toFixed(2)}  |  p-valor: ${teste.pValor.toFixed(4)}`);
    console.log(`  ${teste.significancia}\n`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
