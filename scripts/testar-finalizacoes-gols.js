/**
 * testar-finalizacoes-gols.js
 *
 * Testa finalizações e finalizações no gol como preditor de gols, mesma
 * estrutura usada pra "ataque"/"defesa" de gols -- mas restrito à Série A
 * (única competição com cobertura de estatística passando de 300 jogos).
 *
 * PRELIMINAR: mesmo passando de 300 jogos brutos, a amostra útil real
 * (depois de exigir histórico mínimo por time) fica bem menor -- resultado
 * aqui é um primeiro olhar, não confirmação.
 *
 * Ataque = finalizações feitas pelo próprio time
 * Defesa = finalizações do ADVERSÁRIO naquele jogo (chutes sofridos)
 *
 * Uso:
 *   node scripts/testar-finalizacoes-gols.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MINIMO_JOGOS_TIME = 3;
const MINIMO_JOGOS_LIGA = 10;
const NOME_COMPETICAO = 'Brasileirão Série A';

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

// tipo: 'ataque' (finalizações do próprio time) ou 'defesa' (finalizações do adversário)
function calcularDiffFinalizacoes(historico, timeCasaId, timeForaId, statsPorPartidaTime, campo, tipo) {
  // Jogos do mandante EM CASA, com stats disponíveis dos 2 lados
  const jogosMandante = historico.filter((p) => p.time_casa_id === timeCasaId && statsPorPartidaTime[p.id]?.[p.time_casa_id] && statsPorPartidaTime[p.id]?.[p.time_fora_id]);
  const jogosVisitante = historico.filter((p) => p.time_fora_id === timeForaId && statsPorPartidaTime[p.id]?.[p.time_casa_id] && statsPorPartidaTime[p.id]?.[p.time_fora_id]);
  if (jogosMandante.length < MINIMO_JOGOS_TIME || jogosVisitante.length < MINIMO_JOGOS_TIME) return null;

  const valorMandante = (p) => (tipo === 'ataque' ? statsPorPartidaTime[p.id][p.time_casa_id][campo] : statsPorPartidaTime[p.id][p.time_fora_id][campo]);
  const valorVisitante = (p) => (tipo === 'ataque' ? statsPorPartidaTime[p.id][p.time_fora_id][campo] : statsPorPartidaTime[p.id][p.time_casa_id][campo]);

  const mediaMandante = jogosMandante.reduce((s, p) => s + valorMandante(p), 0) / jogosMandante.length;
  const mediaVisitante = jogosVisitante.reduce((s, p) => s + valorVisitante(p), 0) / jogosVisitante.length;

  const historicoComStats = historico.filter((p) => statsPorPartidaTime[p.id]?.[p.time_casa_id] && statsPorPartidaTime[p.id]?.[p.time_fora_id]);
  if (historicoComStats.length < MINIMO_JOGOS_LIGA) return null;
  const mediaLigaTotal = historicoComStats.reduce((s, p) => s + statsPorPartidaTime[p.id][p.time_casa_id][campo] + statsPorPartidaTime[p.id][p.time_fora_id][campo], 0) / historicoComStats.length;
  const mediaLiga = mediaLigaTotal / 2;
  const mediaConfronto = (mediaMandante + mediaVisitante) / 2;

  return ((mediaConfronto - mediaLiga) / mediaLiga) * 100;
}

async function main() {
  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('nome', NOME_COMPETICAO).single();

  const partidas = await buscarTudoPaginado(
    supabase.from('partidas').select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
      .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null).order('data_hora', { ascending: true })
  );

  const idsPartidas = partidas.map((p) => p.id);
  let stats = [];
  for (let i = 0; i < idsPartidas.length; i += 500) {
    const lote = idsPartidas.slice(i, i + 500);
    const parcial = await buscarTudoPaginado(supabase.from('estatisticas_partida').select('partida_id, time_id, finalizacoes, finalizacoes_no_gol').in('partida_id', lote));
    stats = stats.concat(parcial);
  }

  const statsPorPartidaTime = {};
  for (const s of stats) {
    if (!statsPorPartidaTime[s.partida_id]) statsPorPartidaTime[s.partida_id] = {};
    statsPorPartidaTime[s.partida_id][s.time_id] = { finalizacoes: s.finalizacoes, finalizacoes_no_gol: s.finalizacoes_no_gol };
  }

  console.log(`${partidas.length} jogos de ${NOME_COMPETICAO}, ${stats.length} linhas de estatística encontradas.\n`);

  const VARIANTES = [
    { nome: 'Ataque -- finalizações (total)', campo: 'finalizacoes', tipo: 'ataque' },
    { nome: 'Ataque -- finalizações no gol', campo: 'finalizacoes_no_gol', tipo: 'ataque' },
    { nome: 'Defesa -- finalizações sofridas (total)', campo: 'finalizacoes', tipo: 'defesa' },
    { nome: 'Defesa -- finalizações no gol sofridas', campo: 'finalizacoes_no_gol', tipo: 'defesa' },
  ];

  for (const variante of VARIANTES) {
    const resultados = { '3mais': { total: 0, acertos: 0 }, '2mais': { total: 0, acertos: 0 }, '1mais': { total: 0, acertos: 0 } };
    let totalComIndicador = 0;

    for (let i = 0; i < partidas.length; i++) {
      const partida = partidas[i];
      const historicoAntes = partidas.slice(0, i);

      const diff = calcularDiffFinalizacoes(historicoAntes, partida.time_casa_id, partida.time_fora_id, statsPorPartidaTime, variante.campo, variante.tipo);
      if (diff === null) continue;
      totalComIndicador++;

      const faixa = classificarFaixa(diff);
      if (!faixa) continue;

      const golsTotais = partida.gols_casa + partida.gols_fora;
      const acertou = bateuFaixa(faixa, golsTotais);
      resultados[faixa].total++;
      if (acertou) resultados[faixa].acertos++;
    }

    const totalComFaixa = Object.values(resultados).reduce((s, r) => s + r.total, 0);
    console.log(`=== ${variante.nome} ===`);
    for (const [faixaNome, dados] of Object.entries(resultados)) {
      if (dados.total === 0) { console.log(`  ${faixaNome}: sem casos`); continue; }
      const taxa = (dados.acertos / dados.total) * 100;
      const aviso = dados.total < 60 ? '  ⚠️  amostra pequena' : '';
      console.log(`  ${faixaNome}: ${dados.acertos}/${dados.total} (${taxa.toFixed(1)}%)${aviso}`);
    }
    console.log(`  Jogos com o indicador calculável: ${totalComIndicador}  |  Volume: ${totalComFaixa} (${totalComIndicador > 0 ? ((totalComFaixa / totalComIndicador) * 100).toFixed(1) : 0}%)\n`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
