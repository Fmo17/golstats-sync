/**
 * forca-ponderada.js
 *
 * Constrói um índice de força combinando 8 quesitos, cada um ranqueado
 * (percentil dentro da liga) e PESADO pela correlação real que demonstrou
 * com o resultado -- quesitos com correlação mais forte pesam mais.
 *
 * Quesitos (4 vêm de estatisticas_partida, 4 vêm direto de partidas):
 *   posse_bola, finalizacoes, finalizacoes_no_gol, escanteios  (normais)
 *   gols_pro, vitorias                                          (normais)
 *   gols_contra, derrotas                                       (INVERTIDOS -- menos é melhor)
 *
 * Processo (evita "descobrir peso e testar no mesmo dado", que infla resultado):
 *   Fase 1 (treino, 70% mais antigo): mede a correlação de cada quesito
 *     isolado com "casa venceu", usa |r| como peso.
 *   Fase 2 (teste, 30% mais recente, nunca visto na fase 1): aplica os
 *     pesos fixos da fase 1 e testa o índice combinado.
 *
 * Uso:
 *   node scripts/forca-ponderada.js --competicao=71
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltam variáveis de ambiente: SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const JANELA = 6;
const MINIMO_JOGOS_RANKING = 3;

// Cada quesito: de onde vem o dado, e se precisa inverter (menos = melhor)
const QUESITOS = [
  { chave: 'posse_bola', fonte: 'stats', inverter: false, nome: 'Posse de bola' },
  { chave: 'finalizacoes', fonte: 'stats', inverter: false, nome: 'Finalizações' },
  { chave: 'finalizacoes_no_gol', fonte: 'stats', inverter: false, nome: 'Finalizações no gol' },
  { chave: 'escanteios', fonte: 'stats', inverter: false, nome: 'Escanteios' },
  { chave: 'gols_pro', fonte: 'partidas', inverter: false, nome: 'Gols pró' },
  { chave: 'vitorias', fonte: 'partidas', inverter: false, nome: 'Vitórias' },
  { chave: 'gols_contra', fonte: 'partidas', inverter: true, nome: 'Gols contra' },
  { chave: 'derrotas', fonte: 'partidas', inverter: true, nome: 'Derrotas' },
];

function correlacaoPearson(X, Y) {
  const n = X.length;
  const mediaX = X.reduce((a, b) => a + b, 0) / n;
  const mediaY = Y.reduce((a, b) => a + b, 0) / n;
  let sp = 0, sqx = 0, sqy = 0;
  for (let i = 0; i < n; i++) {
    const dx = X[i] - mediaX, dy = Y[i] - mediaY;
    sp += dx * dy; sqx += dx * dx; sqy += dy * dy;
  }
  const denom = Math.sqrt(sqx * sqy);
  return denom === 0 ? 0 : sp / denom;
}

/**
 * Extrai o valor de um quesito pra um time, numa partida específica --
 * calculado a partir do resultado bruto (gols_casa/gols_fora), não de um
 * campo pronto no banco.
 */
function extrairValorPartidas(partida, timeId, chave) {
  const jogouEmCasa = partida.time_casa_id === timeId;
  const golsPro = jogouEmCasa ? partida.gols_casa : partida.gols_fora;
  const golsContra = jogouEmCasa ? partida.gols_fora : partida.gols_casa;

  if (chave === 'gols_pro') return golsPro;
  if (chave === 'gols_contra') return golsContra;
  if (chave === 'vitorias') return golsPro > golsContra ? 1 : 0;
  if (chave === 'derrotas') return golsPro < golsContra ? 1 : 0;
  return 0;
}

/**
 * Monta o ranking (percentil) de todos os times pra um quesito específico.
 * Se `inverter` for true, quem tem o MENOR valor fica no topo (percentil 1.0).
 */
function montarRanking(historicoCompleto, historicoStats, quesito, statsPorPartidaTime, timesElegiveis, dataReferencia) {
  const fonteHistorico = quesito.fonte === 'stats' ? historicoStats : historicoCompleto;
  const valoresPorTime = [];

  for (const timeId of timesElegiveis) {
    const jogosDoTime = fonteHistorico
      .filter((p) => p.time_casa_id === timeId || p.time_fora_id === timeId)
      .slice(-JANELA);
    if (jogosDoTime.length < MINIMO_JOGOS_RANKING) continue;

    let soma = 0;
    for (const p of jogosDoTime) {
      if (quesito.fonte === 'stats') {
        const st = statsPorPartidaTime[`${p.id}_${timeId}`];
        soma += st?.[quesito.chave] ?? 0;
      } else {
        soma += extrairValorPartidas(p, timeId, quesito.chave);
      }
    }
    valoresPorTime.push({ timeId, valor: soma / jogosDoTime.length });
  }

  // Ordena: normal = maior primeiro; invertido = menor primeiro (quem sofre
  // menos gol ou perde menos fica no topo do ranking)
  valoresPorTime.sort((a, b) => (quesito.inverter ? a.valor - b.valor : b.valor - a.valor));

  const percentis = new Map();
  const total = valoresPorTime.length;
  valoresPorTime.forEach((item, idx) => {
    percentis.set(item.timeId, total > 1 ? 1 - idx / (total - 1) : 0.5);
  });

  return percentis;
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  console.log(`Carregando dados de: ${comp.nome}...`);

  const { data: historicoCompleto } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  const idsPartidas = historicoCompleto.map((p) => p.id);
  const { data: stats } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, time_id, posse_bola, finalizacoes, finalizacoes_no_gol, escanteios')
    .in('partida_id', idsPartidas);

  const statsPorPartidaTime = {};
  for (const s of stats) statsPorPartidaTime[`${s.partida_id}_${s.time_id}`] = s;

  const historicoStats = historicoCompleto.filter((p) => {
    const sc = statsPorPartidaTime[`${p.id}_${p.time_casa_id}`];
    const sf = statsPorPartidaTime[`${p.id}_${p.time_fora_id}`];
    return sc && sf && sc.finalizacoes_no_gol != null && sf.finalizacoes_no_gol != null;
  });

  console.log(`Total de partidas: ${historicoCompleto.length} | Partidas com stats completas: ${historicoStats.length}\n`);

  const todosOsTimes = [...new Set(historicoStats.flatMap((p) => [p.time_casa_id, p.time_fora_id]))];

  // Só trabalhamos com partidas onde os 8 quesitos são calculáveis --
  // limitado pelas 4 que dependem de stats.
  const partidasValidas = [];
  for (let i = 0; i < historicoStats.length; i++) {
    const partida = historicoStats[i];
    const idxCompleto = historicoCompleto.findIndex((p) => p.id === partida.id);
    const anterioresCompleto = historicoCompleto.slice(0, idxCompleto);
    const anterioresStats = historicoStats.slice(0, i);

    if (anterioresStats.length < 15) continue;

    const diffsPorQuesito = {};
    let todosCalculaveis = true;

    for (const quesito of QUESITOS) {
      const ranking = montarRanking(anterioresCompleto, anterioresStats, quesito, statsPorPartidaTime, todosOsTimes, partida.data_hora);
      const pCasa = ranking.get(partida.time_casa_id);
      const pFora = ranking.get(partida.time_fora_id);
      if (pCasa === undefined || pFora === undefined) { todosCalculaveis = false; break; }
      diffsPorQuesito[quesito.chave] = pCasa - pFora;
    }

    if (!todosCalculaveis) continue;

    partidasValidas.push({
      diffs: diffsPorQuesito,
      casaVenceu: partida.gols_casa > partida.gols_fora ? 1 : 0,
    });
  }

  console.log(`Partidas com os 8 quesitos calculáveis: ${partidasValidas.length}\n`);

  if (partidasValidas.length < 60) {
    console.log('Amostra pequena demais pra dividir em treino/teste com confiança -- aguarde mais dado sincronizado.');
    return;
  }

  const corte = Math.floor(partidasValidas.length * 0.7);
  const treino = partidasValidas.slice(0, corte);
  const teste = partidasValidas.slice(corte);

  console.log(`Treino: ${treino.length} partidas | Teste: ${teste.length} partidas\n`);

  // ---------- Fase 1: descobrir o peso de cada quesito (só com dado de treino) ----------
  console.log('=== Fase 1: peso de cada quesito (correlação medida SÓ no treino) ===\n');
  const pesos = {};
  for (const quesito of QUESITOS) {
    const X = treino.map((p) => p.diffs[quesito.chave]);
    const Y = treino.map((p) => p.casaVenceu);
    const r = correlacaoPearson(X, Y);
    pesos[quesito.chave] = Math.abs(r);
    console.log(`  ${quesito.nome}: r = ${r.toFixed(3)}  →  peso = ${Math.abs(r).toFixed(3)}`);
  }

  const somaPesos = Object.values(pesos).reduce((a, b) => a + b, 0);
  console.log(`\n  Soma dos pesos (normalização): ${somaPesos.toFixed(3)}`);

  // ---------- Fase 2: testar o índice combinado no teste (nunca visto na fase 1) ----------
  console.log('\n=== Fase 2: testando o índice combinado no conjunto de TESTE ===\n');

  const indicesTeste = teste.map((p) => {
    let indice = 0;
    for (const quesito of QUESITOS) {
      indice += (pesos[quesito.chave] / somaPesos) * p.diffs[quesito.chave];
    }
    return indice;
  });
  const resultadosTeste = teste.map((p) => p.casaVenceu);

  const rIndiceCombinado = correlacaoPearson(indicesTeste, resultadosTeste);
  console.log(`Correlação do índice combinado com vitória da casa (no teste): r = ${rIndiceCombinado.toFixed(3)}`);

  // Compara com a melhor correlação individual medida no treino (aplicada ao teste)
  let melhorQuesitoIsolado = null, melhorR = 0;
  for (const quesito of QUESITOS) {
    if (pesos[quesito.chave] > melhorR) { melhorR = pesos[quesito.chave]; melhorQuesitoIsolado = quesito; }
  }
  const XIsoladoTeste = teste.map((p) => p.diffs[melhorQuesitoIsolado.chave]);
  const rIsoladoTeste = correlacaoPearson(XIsoladoTeste, resultadosTeste);
  console.log(`Correlação do melhor quesito isolado (${melhorQuesitoIsolado.nome}) no teste: r = ${rIsoladoTeste.toFixed(3)}`);

  console.log(`\n${Math.abs(rIndiceCombinado) > Math.abs(rIsoladoTeste) ? '✅ O índice combinado supera o melhor quesito isolado' : '❌ O melhor quesito isolado sozinho é igual ou melhor que o combinado'}`);

  // Teste de limiar no índice combinado
  console.log('\n=== Sweep de limiares do índice combinado (no teste) ===\n');
  const limiares = [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2];
  for (const limiar of limiares) {
    const indices = indicesTeste.map((v, idx) => (v > limiar ? idx : -1)).filter((idx) => idx >= 0);
    if (indices.length < 10) continue;
    const vitoriasCasa = indices.filter((idx) => resultadosTeste[idx] === 1).length;
    const taxa = (vitoriasCasa / indices.length) * 100;
    console.log(`  Limiar ${limiar.toFixed(2)}: ${indices.length} jogos, ${taxa.toFixed(1)}% de vitória da casa`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
