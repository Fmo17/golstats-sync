/**
 * checar-cobertura-finalizacoes.js
 *
 * Confirma quantos jogos finalizados, por competição, já têm
 * finalizacoes/finalizacoes_no_gol preenchidas -- pré-requisito antes de
 * testar essas estatísticas como preditor de gols.
 *
 * Uso:
 *   node scripts/checar-cobertura-finalizacoes.js
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

  console.log('Competição | Jogos finalizados | Com finalizações | Com finalizações no gol | % cobertura\n');

  for (const comp of competicoes) {
    const partidas = await buscarTudoPaginado(
      supabase.from('partidas').select('id').eq('competicao_id', comp.id).eq('status', 'finalizado')
    );

    if (!partidas || partidas.length === 0) continue;
    const idsPartidas = partidas.map((p) => p.id);

    let comFinalizacoes = 0;
    let comFinalizacoesNoGol = 0;

    for (let i = 0; i < idsPartidas.length; i += 500) {
      const lote = idsPartidas.slice(i, i + 500);
      const stats = await buscarTudoPaginado(
        supabase.from('estatisticas_partida').select('partida_id, finalizacoes, finalizacoes_no_gol').in('partida_id', lote)
      );
      const partidasComFinal = new Set(stats.filter((s) => s.finalizacoes !== null).map((s) => s.partida_id));
      const partidasComFinalNoGol = new Set(stats.filter((s) => s.finalizacoes_no_gol !== null).map((s) => s.partida_id));
      comFinalizacoes += partidasComFinal.size;
      comFinalizacoesNoGol += partidasComFinalNoGol.size;
    }

    const pctCobertura = ((comFinalizacoes / partidas.length) * 100).toFixed(1);
    const aviso = comFinalizacoes < 300 ? '  ⚠️  abaixo do mínimo de 300' : '';
    console.log(`${comp.nome} | ${partidas.length} | ${comFinalizacoes} | ${comFinalizacoesNoGol} | ${pctCobertura}%${aviso}`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
