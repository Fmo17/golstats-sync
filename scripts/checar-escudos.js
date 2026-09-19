/**
 * checar-escudos.js
 *
 * Confirma se os times já têm escudo_url salvo de verdade no banco.
 *
 * Uso:
 *   node scripts/checar-escudos.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  const { data: amostra } = await supabase.from('times').select('id, nome, escudo_url').limit(10);

  console.log('Amostra de 10 times:\n');
  for (const t of amostra) {
    console.log(`  ${t.nome}: ${t.escudo_url || '(vazio)'}`);
  }

  const { count: total } = await supabase.from('times').select('*', { count: 'exact', head: true });
  const { count: comEscudo } = await supabase.from('times').select('*', { count: 'exact', head: true }).not('escudo_url', 'is', null);

  console.log(`\nTotal de times: ${total}`);
  console.log(`Times com escudo_url preenchido: ${comEscudo} (${((comEscudo / total) * 100).toFixed(1)}%)`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
