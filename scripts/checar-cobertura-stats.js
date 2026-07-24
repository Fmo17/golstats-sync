/**
 * checar-cobertura-stats.js
 *
 * Antes de tentar construir um modelo pra escanteios ou cartões, precisamos
 * saber: quantas partidas realmente têm esse dado sincronizado? (lembra que
 * o --stats só processa um lote por execução, então a cobertura pode estar
 * bem incompleta ainda).
 *
 * Uso:
 *   node scripts/checar-cobertura-stats.js --competicao=71
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

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { count: totalPartidas } = await supabase
    .from('partidas')
    .select('*', { count: 'exact', head: true })
    .eq('competicao_id', comp.id)
    .eq('status', 'finalizado');

  const { data: partidasIds } = await supabase
    .from('partidas')
    .select('id')
    .eq('competicao_id', comp.id)
    .eq('status', 'finalizado');

  const idsPartidas = (partidasIds || []).map((p) => p.id);

  const { data: statsExistentes } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, escanteios, cartoes_amarelos, posse_bola, finalizacoes, finalizacoes_no_gol')
    .in('partida_id', idsPartidas);

  const partidasComEscanteios = new Set(
    (statsExistentes || []).filter((s) => s.escanteios !== null).map((s) => s.partida_id)
  );
  const partidasComCartoes = new Set(
    (statsExistentes || []).filter((s) => s.cartoes_amarelos !== null).map((s) => s.partida_id)
  );
  const partidasComPosse = new Set(
    (statsExistentes || []).filter((s) => s.posse_bola !== null).map((s) => s.partida_id)
  );
  const partidasComFinalizacoes = new Set(
    (statsExistentes || []).filter((s) => s.finalizacoes !== null).map((s) => s.partida_id)
  );
  const partidasComFinalizacoesNoGol = new Set(
    (statsExistentes || []).filter((s) => s.finalizacoes_no_gol !== null).map((s) => s.partida_id)
  );

  console.log(`=== Cobertura de dados: ${comp.nome} ===\n`);
  console.log(`Total de partidas finalizadas: ${totalPartidas}`);
  console.log(`Partidas com dado de ESCANTEIOS: ${partidasComEscanteios.size} (${((partidasComEscanteios.size / totalPartidas) * 100).toFixed(1)}%)`);
  console.log(`Partidas com dado de CARTÕES: ${partidasComCartoes.size} (${((partidasComCartoes.size / totalPartidas) * 100).toFixed(1)}%)`);
  console.log(`Partidas com dado de POSSE DE BOLA: ${partidasComPosse.size} (${((partidasComPosse.size / totalPartidas) * 100).toFixed(1)}%)`);
  console.log(`Partidas com dado de FINALIZAÇÕES (total): ${partidasComFinalizacoes.size} (${((partidasComFinalizacoes.size / totalPartidas) * 100).toFixed(1)}%)`);
  console.log(`Partidas com dado de FINALIZAÇÕES NO GOL: ${partidasComFinalizacoesNoGol.size} (${((partidasComFinalizacoesNoGol.size / totalPartidas) * 100).toFixed(1)}%)`);

  const MINIMO_RECOMENDADO = 300;
  console.log(`\nPra um backtest minimamente confiável, recomendo pelo menos ~${MINIMO_RECOMENDADO} partidas com dado.`);
  console.log(`Escanteios: ${partidasComEscanteios.size >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
  console.log(`Cartões: ${partidasComCartoes.size >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
  console.log(`Posse de bola: ${partidasComPosse.size >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
  console.log(`Finalizações: ${partidasComFinalizacoes.size >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
  console.log(`Finalizações no gol: ${partidasComFinalizacoesNoGol.size >= MINIMO_RECOMENDADO ? '✅ dado suficiente pra tentar' : '❌ ainda não tem dado suficiente'}`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
