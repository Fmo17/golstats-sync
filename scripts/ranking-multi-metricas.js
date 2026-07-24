/**
 * ranking-multi-metricas.js
 *
 * Pra cada uma das 4 métricas (posse de bola, finalizações, finalizações no
 * gol, escanteios), ranqueia os times da liga (percentil 0 a 1, sempre só
 * com dado anterior ao jogo -- sem olhar o futuro) e calcula a DIFERENÇA de
 * posição entre mandante e visitante em cada confronto.
 *
 * Testa se essa diferença de ranking correlaciona com o resultado real
 * (vitória do mandante) e com o saldo de gols da partida -- tanto métrica
 * por métrica quanto um "placar combinado" somando as 4.
 *
 * Uso:
 *   node scripts/ranking-multi-metricas.js --competicao=71
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
 * Monta o ranking (percentil) de todos os times pra uma métrica específica,
 * usando só jogos anteriores (com stats) já disputados.
 */
function montarRanking(jogosAnteriores, campo, statsPorPartidaTime, timesElegiveis) {
  const valoresPorTime = [];

  for (const timeId of timesElegiveis) {
    const jogosDoTime = jogosAnteriores.filter((p) => p.time_casa_id === timeId || p.time_fora_id === timeId).slice(-JANELA);
    if (jogosDoTime.length < MINIMO_JOGOS_RANKING) continue;

    const soma = jogosDoTime.reduce((s, p) => {
      const st = statsPorPartidaTime[`${p.id}_${timeId}`];
      return s + (st?.[campo] ?? 0);
    }, 0);

    valoresPorTime.push({ timeId, valor: soma / jogosDoTime.length });
  }

  valoresPorTime.sort((a, b) => b.valor - a.valor);
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

  console.log(`Carregando partidas com stats de: ${comp.nome}...`);

  const { data: todasPartidas } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  const idsPartidas = todasPartidas.map((p) => p.id);
  const { data: stats } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, time_id, posse_bola, finalizacoes, finalizacoes_no_gol, escanteios')
    .in('partida_id', idsPartidas);

  const statsPorPartidaTime = {};
  for (const s of stats) statsPorPartidaTime[`${s.partida_id}_${s.time_id}`] = s;

  const partidasComStats = todasPartidas.filter((p) => {
    const sc = statsPorPartidaTime[`${p.id}_${p.time_casa_id}`];
    const sf = statsPorPartidaTime[`${p.id}_${p.time_fora_id}`];
    return sc && sf && sc.finalizacoes_no_gol != null && sf.finalizacoes_no_gol != null;
  });

  console.log(`Partidas com stats completas: ${partidasComStats.length}\n`);

  const todosOsTimes = [...new Set(partidasComStats.flatMap((p) => [p.time_casa_id, p.time_fora_id]))];

  const metricas = [
    { campo: 'posse_bola', nome: 'Posse de bola' },
    { campo: 'finalizacoes', nome: 'Finalizações' },
    { campo: 'finalizacoes_no_gol', nome: 'Finalizações no gol' },
    { campo: 'escanteios', nome: 'Escanteios' },
  ];

  const diffsPorMetrica = { posse_bola: [], finalizacoes: [], finalizacoes_no_gol: [], escanteios: [] };
  const diffsCombinados = [];
  const casaVenceu = [];
  const saldoGols = [];

  for (let i = 0; i < partidasComStats.length; i++) {
    const partida = partidasComStats[i];
    const anteriores = partidasComStats.slice(0, i);
    if (anteriores.length < 15) continue; // aquecimento mínimo pra ranking fazer sentido

    let somaDiffs = 0;
    let todasMetricasDisponiveis = true;
    const diffsDessaPartida = {};

    for (const metrica of metricas) {
      const ranking = montarRanking(anteriores, metrica.campo, statsPorPartidaTime, todosOsTimes);
      const percentilCasa = ranking.get(partida.time_casa_id);
      const percentilFora = ranking.get(partida.time_fora_id);

      if (percentilCasa === undefined || percentilFora === undefined) {
        todasMetricasDisponiveis = false;
        break;
      }

      const diff = percentilCasa - percentilFora;
      diffsDessaPartida[metrica.campo] = diff;
      somaDiffs += diff;
    }

    if (!todasMetricasDisponiveis) continue;

    for (const metrica of metricas) diffsPorMetrica[metrica.campo].push(diffsDessaPartida[metrica.campo]);
    diffsCombinados.push(somaDiffs);
    casaVenceu.push(partida.gols_casa > partida.gols_fora ? 1 : 0);
    saldoGols.push(partida.gols_casa - partida.gols_fora);
  }

  console.log(`Partidas analisadas (com ranking completo disponível): ${diffsCombinados.length}\n`);

  if (diffsCombinados.length < 30) {
    console.log('Amostra pequena demais pra conclusão confiável -- aguarde mais dado sincronizado.');
    return;
  }

  console.log('=== Correlação de cada métrica (diferença de ranking) com o resultado ===\n');
  for (const metrica of metricas) {
    const rVitoria = correlacaoPearson(diffsPorMetrica[metrica.campo], casaVenceu);
    const rSaldo = correlacaoPearson(diffsPorMetrica[metrica.campo], saldoGols);
    console.log(`${metrica.nome}: r com vitória = ${rVitoria.toFixed(3)}  |  r com saldo de gols = ${rSaldo.toFixed(3)}`);
  }

  console.log('\n=== Placar combinado (soma das 4 diferenças de ranking) ===');
  const rVitoriaComb = correlacaoPearson(diffsCombinados, casaVenceu);
  const rSaldoComb = correlacaoPearson(diffsCombinados, saldoGols);
  console.log(`Combinado: r com vitória = ${rVitoriaComb.toFixed(3)}  |  r com saldo de gols = ${rSaldoComb.toFixed(3)}`);
  console.log('\n(Referência: abaixo de 0.1 = praticamente nenhuma relação; 0.1-0.3 = fraca; 0.3-0.5 = moderada; acima = forte)');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
