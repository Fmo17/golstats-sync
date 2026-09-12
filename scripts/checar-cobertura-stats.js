/**
 * checar-cobertura-stats.js
 *
 * Verifica quantas partidas finalizadas de uma competição já têm dado de
 * escanteios/cartões/posse/finalizações -- com PAGINAÇÃO COMPLETA, pra nunca
 * mais bater no limite silencioso de 1000 linhas do Supabase (bug que
 * causava contagem de cobertura sempre errada em ligas com muitos jogos).
 *
 * Uso:
 *   node scripts/checar-cobertura-stats.js --competicao=71
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Busca TODAS as linhas de uma tabela que batem com um filtro, paginando em
 * blocos de 1000 até esgotar -- nunca confia no limite padrão do Supabase.
 */
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
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const partidas = await buscarTudoPaginado(
    supabase.from('partidas').select('id').eq('competicao_id', comp.id).eq('status', 'finalizado')
  );
  const totalPartidas = partidas.length;
  const idsPartidas = partidas.map((p) => p.id);

  console.log(`Total de partidas finalizadas (contagem real, paginada): ${totalPartidas}`);

  // Busca as estatísticas em blocos de 500 IDs por vez (pra não estourar o
  // tamanho da URL da consulta `.in()` com milhares de IDs de uma vez).
  let statsExistentes = [];
  for (let i = 0; i < idsPartidas.length; i += 500) {
    const loteIds = idsPartidas.slice(i, i + 500);
    const bloco = await buscarTudoPaginado(
      supabase.from('estatisticas_partida')
        .select('partida_id, escanteios, cartoes_amarelos, posse_bola, finalizacoes, finalizacoes_no_gol')
        .in('partida_id', loteIds)
    );
    statsExistentes = statsExistentes.concat(bloco);
  }

  const contar = (campo) => new Set(statsExistentes.filter((s) => s[campo] !== null).map((s) => s.partida_id)).size;

  const comEscanteios = contar('escanteios');
  const comCartoes = contar('cartoes_amarelos');
  const comPosse = contar('posse_bola');
  const comFinalizacoes = contar('finalizacoes');
  const comFinalizacoesNoGol = contar('finalizacoes_no_gol');

  console.log(`\n=== Cobertura de dados: ${comp.nome} ===\n`);
  console.log(`Total de partidas finalizadas: ${totalPartidas}`);
  console.log(`Partidas com dado de ESCANTEIOS: ${comEscanteios} (${((comEscanteios / totalPartidas) * 100).toFixed(1)}%)`);
  console.log(`Partidas com dado de CARTÕES: ${comCartoes} (${((comCartoes / totalPartidas) * 100).toFixed(1)}%)`);
  console.log(`Partidas com dado de POSSE DE BOLA: ${comPosse} (${((comPosse / totalPartidas) * 100).toFixed(1)}%)`);
  console.log(`Partidas com dado de FINALIZAÇÕES (total): ${comFinalizacoes} (${((comFinalizacoes / totalPartidas) * 100).toFixed(1)}%)`);
  console.log(`Partidas com dado de FINALIZAÇÕES NO GOL: ${comFinalizacoesNoGol} (${((comFinalizacoesNoGol / totalPartidas) * 100).toFixed(1)}%)`);

  const MINIMO_RECOMENDADO = 300;
  console.log(`\nPra um backtest minimamente confiável, recomendo pelo menos ~${MINIMO_RECOMENDADO} partidas com dado.`);
  console.log(`Escanteios: ${comEscanteios >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
  console.log(`Cartões: ${comCartoes >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
  console.log(`Posse de bola: ${comPosse >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
  console.log(`Finalizações: ${comFinalizacoes >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
  console.log(`Finalizações no gol: ${comFinalizacoesNoGol >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
