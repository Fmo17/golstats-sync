/**
 * checar-cobertura-posse.js
 *
 * Confirma quantos jogos finalizados, por competição, já têm posse_bola
 * e escanteios preenchidos -- mesma checagem que fizemos pra finalizações.
 *
 * Uso:
 *   node scripts/checar-cobertura-posse.js
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
  const { data: competicoes } = await supabase.from('competicoes').select('id, nome').eq('ativa', true).order('nome');

  console.log('Competição | Jogos finalizados | Com posse de bola | Com escanteios | % posse | % escanteios\n');

  let totalJogos = 0;
  let totalComPosse = 0;
  let totalComEscanteios = 0;

  for (const comp of competicoes) {
    const partidas = await buscarTudoPaginado(
      supabase.from('partidas').select('id').eq('competicao_id', comp.id).eq('status', 'finalizado')
    );

    if (!partidas || partidas.length === 0) continue;
    const idsPartidas = partidas.map((p) => p.id);

    let comPosse = 0;
    let comEscanteios = 0;
    for (let i = 0; i < idsPartidas.length; i += 500) {
      const lote = idsPartidas.slice(i, i + 500);
      const stats = await buscarTudoPaginado(
        supabase.from('estatisticas_partida').select('partida_id, posse_bola, escanteios').in('partida_id', lote)
      );
      const partidasComPosse = new Set(stats.filter((s) => s.posse_bola !== null).map((s) => s.partida_id));
      const partidasComEscanteios = new Set(stats.filter((s) => s.escanteios !== null).map((s) => s.partida_id));
      comPosse += partidasComPosse.size;
      comEscanteios += partidasComEscanteios.size;
    }

    totalJogos += partidas.length;
    totalComPosse += comPosse;
    totalComEscanteios += comEscanteios;

    const pctPosse = ((comPosse / partidas.length) * 100).toFixed(1);
    const pctEscanteios = ((comEscanteios / partidas.length) * 100).toFixed(1);
    const avisoPosse = comPosse < 300 ? ' ⚠️' : '';
    const avisoEscanteios = comEscanteios < 300 ? ' ⚠️' : '';
    console.log(`${comp.nome} | ${partidas.length} | ${comPosse} | ${comEscanteios} | ${pctPosse}%${avisoPosse} | ${pctEscanteios}%${avisoEscanteios}`);
  }

  console.log(`\nTOTAL GERAL -- posse: ${totalComPosse}/${totalJogos} (${((totalComPosse / totalJogos) * 100).toFixed(1)}%)  |  escanteios: ${totalComEscanteios}/${totalJogos} (${((totalComEscanteios / totalJogos) * 100).toFixed(1)}%)`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
