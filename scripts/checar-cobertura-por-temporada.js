/**
 * checar-cobertura-por-temporada.js
 *
 * Verifica se a cobertura de posse/finalizações está concentrada só nas
 * temporadas mais recentes, ou se está espalhada de forma parecida em
 * todas -- pra saber se "olhar mais temporadas" realmente ajudaria a
 * resolver a limitação de amostra.
 *
 * Uso:
 *   node scripts/checar-cobertura-por-temporada.js [--competicao="Brasileirão Série A"]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

async function main() {
  const args = process.argv.slice(2);
  const compArg = args.find((a) => a.startsWith('--competicao='));
  const nomeCompeticao = compArg ? compArg.split('=')[1] : 'Brasileirão Série A';

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('nome', nomeCompeticao).single();

  const partidas = await buscarTudoPaginado(
    supabase.from('partidas').select('id, data_hora').eq('competicao_id', comp.id).eq('status', 'finalizado')
  );

  const idsPartidas = partidas.map((p) => p.id);
  let stats = [];
  for (let i = 0; i < idsPartidas.length; i += 500) {
    const lote = idsPartidas.slice(i, i + 500);
    const parcial = await buscarTudoPaginado(supabase.from('estatisticas_partida').select('partida_id, posse_bola').in('partida_id', lote));
    stats = stats.concat(parcial);
  }
  const idsPartidasComPosse = new Set(stats.filter((s) => s.posse_bola !== null).map((s) => s.partida_id));

  // Agrupa por ANO (aproximação de temporada)
  const porAno = {};
  for (const p of partidas) {
    const ano = new Date(p.data_hora).getFullYear();
    if (!porAno[ano]) porAno[ano] = { total: 0, comPosse: 0 };
    porAno[ano].total++;
    if (idsPartidasComPosse.has(p.id)) porAno[ano].comPosse++;
  }

  console.log(`=== ${nomeCompeticao}: cobertura de posse de bola por ano ===\n`);
  for (const ano of Object.keys(porAno).sort()) {
    const { total, comPosse } = porAno[ano];
    const pct = ((comPosse / total) * 100).toFixed(1);
    console.log(`  ${ano}: ${comPosse}/${total} jogos (${pct}%)`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
