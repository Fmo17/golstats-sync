/**
 * diagnostico-finalizacoes.js
 *
 * Verifica se os campos "finalizacoes" e "finalizacoes_no_gol" estão
 * realmente com valores diferentes no banco, ou se há algum problema de
 * sincronização fazendo os dois terem o mesmo valor sempre.
 *
 * Uso:
 *   node scripts/diagnostico-finalizacoes.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  const { data: amostra } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, time_id, finalizacoes, finalizacoes_no_gol, posse_bola, escanteios')
    .not('finalizacoes_no_gol', 'is', null)
    .limit(20);

  console.log('Amostra de 20 registros de estatisticas_partida:\n');
  console.log('partida_id | time_id | finalizacoes | finalizacoes_no_gol | posse | escanteios | iguais?');
  console.log('-----------|---------|--------------|----------------------|-------|------------|--------');

  let quantosIguais = 0;
  for (const s of amostra) {
    const iguais = s.finalizacoes === s.finalizacoes_no_gol;
    if (iguais) quantosIguais++;
    console.log(`${String(s.partida_id).padEnd(10)} | ${String(s.time_id).padEnd(7)} | ${String(s.finalizacoes).padEnd(12)} | ${String(s.finalizacoes_no_gol).padEnd(20)} | ${String(s.posse_bola).padEnd(5)} | ${String(s.escanteios).padEnd(10)} | ${iguais ? '⚠️ SIM' : 'não'}`);
  }

  console.log(`\n${quantosIguais} de ${amostra.length} registros têm finalizacoes === finalizacoes_no_gol`);

  // Verifica na base inteira
  const { data: todos } = await supabase
    .from('estatisticas_partida')
    .select('finalizacoes, finalizacoes_no_gol')
    .not('finalizacoes_no_gol', 'is', null)
    .not('finalizacoes', 'is', null);

  const totalIguaisGeral = todos.filter((s) => s.finalizacoes === s.finalizacoes_no_gol).length;
  console.log(`\nNa base inteira: ${totalIguaisGeral} de ${todos.length} registros têm os dois campos idênticos (${((totalIguaisGeral / todos.length) * 100).toFixed(1)}%).`);
  console.log(totalIguaisGeral / todos.length > 0.5
    ? '⚠️  Mais de 50% idênticos -- provável problema de sincronização (os 2 campos podem estar mapeados pra mesma coisa).'
    : '✅ Maioria diferente -- os campos parecem estar sincronizados corretamente.');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
