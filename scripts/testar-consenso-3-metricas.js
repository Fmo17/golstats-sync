/**
 * testar-consenso-3-metricas.js
 *
 * Testa 2 hipóteses de consenso entre posse de bola, escanteios e
 * finalizações, como preditor de vencedor:
 *
 *   1. CONVERGÊNCIA TOTAL: as 3 métricas apontam pro mesmo time
 *   2. CONVERGÊNCIA PARCIAL: posse aponta pro time, E (escanteios OU
 *      finalizações também apontam pro mesmo time)
 *
 * Roda em Série A + Série B (únicas com cobertura suficiente).
 *
 * Uso:
 *   node scripts/testar-consenso-3-metricas.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MINIMO_JOGOS_TIME = 3;
const COMPETICOES_QUALIFICADAS = ['Brasileirão Série A', 'Brasileirão Série B'];

async function buscarTudoPaginado(query) {
  const TAMANHO_PAGINA = 1000;
  let pagina = 0;
  let todos = [];
  while (true) {
    const { data, error } = await query.range(pagina * TAMANHO_PAGINA, pagina * TAMANHO_PAGINA + TAMANHO_PAGINA - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    todos = todos.concat(data);
    if (data.length < TAMANHO_PAGINA) break;
    pagina++;
  }
  return todos;
}

// Retorna 'mandante', 'visitante', ou null (empate na média, ou dado insuficiente)
function quemTemMaiorMedia(historico, timeCasaId, timeForaId, statsPorPartidaTime, campo) {
  const jogosMandante = historico.filter((p) => p.time_casa_id === timeCasaId && statsPorPartidaTime[p.id]?.[p.time_casa_id]?.[campo] !== undefined);
  const jogosVisitante = historico.filter((p) => p.time_fora_id === timeForaId && statsPorPartidaTime[p.id]?.[p.time_fora_id]?.[campo] !== undefined);
  if (jogosMandante.length < MINIMO_JOGOS_TIME || jogosVisitante.length < MINIMO_JOGOS_TIME) return null;

  const mediaMandante = jogosMandante.reduce((s, p) => s + statsPorPartidaTime[p.id][p.time_casa_id][campo], 0) / jogosMandante.length;
  const mediaVisitante = jogosVisitante.reduce((s, p) => s + statsPorPartidaTime[p.id][p.time_fora_id][campo], 0) / jogosVisitante.length;

  if (mediaMandante === mediaVisitante) return null;
  return mediaMandante > mediaVisitante ? 'mandante' : 'visitante';
}

async function main() {
  let baseVitoriaMandante = 0, baseVitoriaVisitante = 0, baseEmpate = 0, baseTotal = 0;

  const conv1 = {
    mandante: { acertos: 0, empates: 0, erros: 0, total: 0 },
    visitante: { acertos: 0, empates: 0, erros: 0, total: 0 },
  };
  const conv2 = {
    mandante: { acertos: 0, empates: 0, erros: 0, total: 0 },
    visitante: { acertos: 0, empates: 0, erros: 0, total: 0 },
  };

  for (const nomeCompeticao of COMPETICOES_QUALIFICADAS) {
    const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('nome', nomeCompeticao).single();

    const partidas = await buscarTudoPaginado(
      supabase.from('partidas').select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
        .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null).order('data_hora', { ascending: true })
    );

    const idsPartidas = partidas.map((p) => p.id);
    let stats = [];
    for (let i = 0; i < idsPartidas.length; i += 500) {
      const lote = idsPartidas.slice(i, i + 500);
      const parcial = await buscarTudoPaginado(
        supabase.from('estatisticas_partida').select('partida_id, time_id, posse_bola, escanteios, finalizacoes').in('partida_id', lote)
      );
      stats = stats.concat(parcial);
    }

    const statsPorPartidaTime = {};
    for (const s of stats) {
      if (!statsPorPartidaTime[s.partida_id]) statsPorPartidaTime[s.partida_id] = {};
      statsPorPartidaTime[s.partida_id][s.time_id] = { posse_bola: s.posse_bola, escanteios: s.escanteios, finalizacoes: s.finalizacoes };
    }

    console.log(`${nomeCompeticao}: ${partidas.length} jogos`);

    for (let i = 0; i < partidas.length; i++) {
      const partida = partidas[i];
      baseTotal++;
      if (partida.gols_casa > partida.gols_fora) baseVitoriaMandante++;
      else if (partida.gols_casa < partida.gols_fora) baseVitoriaVisitante++;
      else baseEmpate++;

      const historicoAntes = partidas.slice(0, i);

      const quemPosse = quemTemMaiorMedia(historicoAntes, partida.time_casa_id, partida.time_fora_id, statsPorPartidaTime, 'posse_bola');
      const quemEscanteios = quemTemMaiorMedia(historicoAntes, partida.time_casa_id, partida.time_fora_id, statsPorPartidaTime, 'escanteios');
      const quemFinalizacoes = quemTemMaiorMedia(historicoAntes, partida.time_casa_id, partida.time_fora_id, statsPorPartidaTime, 'finalizacoes');

      const resultadoReal = partida.gols_casa > partida.gols_fora ? 'mandante' : partida.gols_casa < partida.gols_fora ? 'visitante' : 'empate';

      // Hipótese 1: convergência total (as 3 apontam pro mesmo time)
      if (quemPosse && quemPosse === quemEscanteios && quemPosse === quemFinalizacoes) {
        const grupo = conv1[quemPosse];
        grupo.total++;
        if (resultadoReal === quemPosse) grupo.acertos++;
        else if (resultadoReal === 'empate') grupo.empates++;
        else grupo.erros++;
      }

      // Hipótese 2: posse + pelo menos 1 das outras 2 apontando pro mesmo time
      if (quemPosse && (quemPosse === quemEscanteios || quemPosse === quemFinalizacoes)) {
        const grupo = conv2[quemPosse];
        grupo.total++;
        if (resultadoReal === quemPosse) grupo.acertos++;
        else if (resultadoReal === 'empate') grupo.empates++;
        else grupo.erros++;
      }
    }
  }

  console.log('\n=== Referência: taxa NORMAL de resultado (sem filtro nenhum) ===');
  console.log(`  Vitória mandante: ${baseVitoriaMandante}/${baseTotal} (${((baseVitoriaMandante / baseTotal) * 100).toFixed(1)}%)`);
  console.log(`  Vitória visitante: ${baseVitoriaVisitante}/${baseTotal} (${((baseVitoriaVisitante / baseTotal) * 100).toFixed(1)}%)\n`);

  function relatarSubgrupo(nome, grupo, baseComparavel) {
    if (grupo.total === 0) { console.log(`  ${nome}: sem casos`); return; }
    const taxaComEmpates = (grupo.acertos / grupo.total) * 100;
    const decisivos = grupo.acertos + grupo.erros;
    const taxaSemEmpates = decisivos > 0 ? (grupo.acertos / decisivos) * 100 : null;
    console.log(`  ${nome} (${grupo.total} casos):`);
    console.log(`    Acerto (com empate): ${grupo.acertos}/${grupo.total} (${taxaComEmpates.toFixed(1)}%)`);
    if (taxaSemEmpates !== null) console.log(`    Acerto (só decisivos): ${grupo.acertos}/${decisivos} (${taxaSemEmpates.toFixed(1)}%)`);
    console.log(`    Referência normal dessa direção: ${baseComparavel.toFixed(1)}%`);
    if (grupo.total < 60) console.log('    ⚠️  amostra pequena');
  }

  const refMandante = (baseVitoriaMandante / baseTotal) * 100;
  const refVisitante = (baseVitoriaVisitante / baseTotal) * 100;

  console.log('=== HIPÓTESE 1: convergência TOTAL (posse + escanteios + finalizações) ===');
  relatarSubgrupo('Quando aponta pro MANDANTE', conv1.mandante, refMandante);
  relatarSubgrupo('Quando aponta pro VISITANTE', conv1.visitante, refVisitante);

  console.log('\n=== HIPÓTESE 2: convergência PARCIAL (posse + pelo menos 1 das outras 2) ===');
  relatarSubgrupo('Quando aponta pro MANDANTE', conv2.mandante, refMandante);
  relatarSubgrupo('Quando aponta pro VISITANTE', conv2.visitante, refVisitante);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
