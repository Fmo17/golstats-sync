/**
 * teste-consenso.js
 *
 * Testa se EXIGIR que os 2 sinais de vitória do mandante concordem (fator
 * combinado positivo E índice de força ponderado positivo) dá uma taxa de
 * acerto melhor do que usar qualquer um dos dois sozinho.
 *
 * Separa os jogos em 4 grupos:
 *   - Ambos positivos (consenso)
 *   - Só o fator combinado positivo
 *   - Só a força ponderada positiva
 *   - Nenhum dos dois positivo
 *
 * Uso:
 *   node scripts/teste-consenso.js --competicao=71
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

// ---------- Fator combinado (mesma lógica de calcular-sinais.js) ----------
const MINIMO_JOGOS = 3;

function calcularFatorCombinado(partidasAnteriores, timeCasaId, timeForaId) {
  const jogosCasaTimeCasa = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId);
  if (jogosCasaTimeCasa.length < MINIMO_JOGOS) return null;
  const mediaGolsFeitosCasa = jogosCasaTimeCasa.reduce((s, p) => s + p.gols_casa, 0) / jogosCasaTimeCasa.length;

  const jogosForaTimeFora = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId);
  if (jogosForaTimeFora.length < MINIMO_JOGOS) return null;
  const mediaGolsSofridosFora = jogosForaTimeFora.reduce((s, p) => s + p.gols_casa, 0) / jogosForaTimeFora.length;

  if (partidasAnteriores.length < 10) return null;
  const mediaLigaGolsCasa = partidasAnteriores.reduce((s, p) => s + p.gols_casa, 0) / partidasAnteriores.length;

  const diferencaAtaque = mediaGolsFeitosCasa - mediaLigaGolsCasa;
  const diferencaDefesa = mediaGolsSofridosFora - mediaLigaGolsCasa;
  return diferencaAtaque + diferencaDefesa;
}

// ---------- Força ponderada (8 quesitos, pesos fixos calculados na Série A) ----------
const JANELA_QUESITOS = 6;
const MINIMO_JOGOS_RANKING_QUESITOS = 3;

const QUESITOS = [
  { chave: 'posse_bola', fonte: 'stats', inverter: false, peso: 0.186 },
  { chave: 'finalizacoes', fonte: 'stats', inverter: false, peso: 0.180 },
  { chave: 'finalizacoes_no_gol', fonte: 'stats', inverter: false, peso: 0.188 },
  { chave: 'escanteios', fonte: 'stats', inverter: false, peso: 0.123 },
  { chave: 'gols_pro', fonte: 'partidas', inverter: false, peso: 0.129 },
  { chave: 'vitorias', fonte: 'partidas', inverter: false, peso: 0.202 },
  { chave: 'gols_contra', fonte: 'partidas', inverter: true, peso: 0.107 },
  { chave: 'derrotas', fonte: 'partidas', inverter: true, peso: 0.067 },
];
const SOMA_PESOS_QUESITOS = QUESITOS.reduce((s, q) => s + q.peso, 0);

function extrairValorPartidasQuesito(partida, timeId, chave) {
  const jogouEmCasa = partida.time_casa_id === timeId;
  const golsPro = jogouEmCasa ? partida.gols_casa : partida.gols_fora;
  const golsContra = jogouEmCasa ? partida.gols_fora : partida.gols_casa;
  if (chave === 'gols_pro') return golsPro;
  if (chave === 'gols_contra') return golsContra;
  if (chave === 'vitorias') return golsPro > golsContra ? 1 : 0;
  if (chave === 'derrotas') return golsPro < golsContra ? 1 : 0;
  return 0;
}

function montarRankingQuesito(historicoCompleto, historicoStats, quesito, statsPorPartidaTime, timesElegiveis) {
  const fonteHistorico = quesito.fonte === 'stats' ? historicoStats : historicoCompleto;
  const valoresPorTime = [];
  for (const timeId of timesElegiveis) {
    const jogosDoTime = fonteHistorico.filter((p) => p.time_casa_id === timeId || p.time_fora_id === timeId).slice(-JANELA_QUESITOS);
    if (jogosDoTime.length < MINIMO_JOGOS_RANKING_QUESITOS) continue;
    let soma = 0;
    for (const p of jogosDoTime) {
      if (quesito.fonte === 'stats') {
        const st = statsPorPartidaTime[`${p.id}_${timeId}`];
        soma += st?.[quesito.chave] ?? 0;
      } else {
        soma += extrairValorPartidasQuesito(p, timeId, quesito.chave);
      }
    }
    valoresPorTime.push({ timeId, valor: soma / jogosDoTime.length });
  }
  valoresPorTime.sort((a, b) => (quesito.inverter ? a.valor - b.valor : b.valor - a.valor));
  const percentis = new Map();
  const total = valoresPorTime.length;
  valoresPorTime.forEach((item, idx) => percentis.set(item.timeId, total > 1 ? 1 - idx / (total - 1) : 0.5));
  return percentis;
}

function calcularIndiceForca(historicoCompleto, historicoStats, timeCasaId, timeForaId, statsPorPartidaTime, timesElegiveis) {
  let indice = 0;
  for (const quesito of QUESITOS) {
    const ranking = montarRankingQuesito(historicoCompleto, historicoStats, quesito, statsPorPartidaTime, timesElegiveis);
    const pCasa = ranking.get(timeCasaId);
    const pFora = ranking.get(timeForaId);
    if (pCasa === undefined || pFora === undefined) return null;
    indice += (quesito.peso / SOMA_PESOS_QUESITOS) * (pCasa - pFora);
  }
  return indice;
}

// ---------- Fluxo principal ----------

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  console.log(`Carregando dados de: ${comp.nome}...`);
  const { data: todasPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  const idsPartidas = todasPartidas.map((p) => p.id);
  const { data: statsRaw } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, time_id, posse_bola, finalizacoes, finalizacoes_no_gol, escanteios')
    .in('partida_id', idsPartidas);

  const statsPorPartidaTime = {};
  for (const s of statsRaw || []) statsPorPartidaTime[`${s.partida_id}_${s.time_id}`] = s;

  const todasPartidasComStats = todasPartidas.filter((p) => {
    const sc = statsPorPartidaTime[`${p.id}_${p.time_casa_id}`];
    const sf = statsPorPartidaTime[`${p.id}_${p.time_fora_id}`];
    return sc && sf && sc.finalizacoes_no_gol != null && sf.finalizacoes_no_gol != null;
  });

  const todosOsTimes = [...new Set(todasPartidas.flatMap((p) => [p.time_casa_id, p.time_fora_id]))];

  console.log(`Total de partidas: ${todasPartidas.length} | Com stats completas: ${todasPartidasComStats.length}\n`);

  const grupos = {
    ambosPositivos: [],
    soFator: [],
    soForca: [],
    nenhum: [],
  };

  for (let i = 0; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);
    const anterioresComStats = todasPartidasComStats.filter((p) => new Date(p.data_hora) < new Date(partida.data_hora));

    const fator = calcularFatorCombinado(anteriores, partida.time_casa_id, partida.time_fora_id);
    const indiceForca = calcularIndiceForca(anteriores, anterioresComStats, partida.time_casa_id, partida.time_fora_id, statsPorPartidaTime, todosOsTimes);

    // Só entra na análise se os 2 sinais forem calculáveis (precisa de dado suficiente pros 2)
    if (fator === null || indiceForca === null) continue;

    const fatorPositivo = fator > 0;
    const forcaPositiva = indiceForca > 0;
    const casaVenceu = partida.gols_casa > partida.gols_fora;

    if (fatorPositivo && forcaPositiva) grupos.ambosPositivos.push(casaVenceu);
    else if (fatorPositivo && !forcaPositiva) grupos.soFator.push(casaVenceu);
    else if (!fatorPositivo && forcaPositiva) grupos.soForca.push(casaVenceu);
    else grupos.nenhum.push(casaVenceu);
  }

  console.log('=== Resultado por grupo ===\n');

  const rotulos = {
    ambosPositivos: 'CONSENSO -- os 2 sinais positivos pro mandante',
    soFator: 'Só o fator combinado positivo (força ponderada não confirma)',
    soForca: 'Só a força ponderada positiva (fator combinado não confirma)',
    nenhum: 'Nenhum dos 2 positivo',
  };

  for (const chave of ['ambosPositivos', 'soFator', 'soForca', 'nenhum']) {
    const casos = grupos[chave];
    if (casos.length === 0) {
      console.log(`${rotulos[chave]}: 0 jogos.\n`);
      continue;
    }
    const vitorias = casos.filter((x) => x).length;
    const taxa = (vitorias / casos.length) * 100;
    console.log(`${rotulos[chave]}: ${casos.length} jogos, ${vitorias} vitórias da casa (${taxa.toFixed(1)}%)`);
    if (casos.length < 30) console.log('  ⚠️  Amostra pequena, resultado pouco confiável ainda.');
    console.log('');
  }

  const todosOsJogos = [...grupos.ambosPositivos, ...grupos.soFator, ...grupos.soForca, ...grupos.nenhum];
  const taxaBaseGeral = (todosOsJogos.filter((x) => x).length / todosOsJogos.length) * 100;
  console.log(`Linha de base geral (taxa de vitória da casa em todos os jogos analisados): ${taxaBaseGeral.toFixed(1)}%`);
  console.log('\n(Se o consenso realmente vale a pena, o grupo "ambos positivos" deveria ter a maior taxa de');
  console.log('todos os grupos -- maior até que "só um dos dois positivo".)');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
