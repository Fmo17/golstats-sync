/**
 * testar-fixture-bruto.js
 *
 * Mostra a resposta CRUA e completa da API-Football pro endpoint de
 * estatísticas de uma partida específica -- sem nenhum processamento
 * nosso no meio, pra diagnosticar por que está vindo vazio.
 *
 * Uso:
 *   node scripts/testar-fixture-bruto.js --partida=102752
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_FOOTBALL_KEY };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  const args = process.argv.slice(2);
  const partidaId = parseInt(args.find((a) => a.startsWith('--partida=')).split('=')[1], 10);

  const { data: partida } = await supabase
    .from('partidas')
    .select('id, api_football_id, data_hora, status, gols_casa, gols_fora')
    .eq('id', partidaId)
    .single();

  console.log('=== Partida no nosso banco ===');
  console.log(JSON.stringify(partida, null, 2));
  console.log('');

  const url = new URL(`${API_BASE}/fixtures/statistics`);
  url.searchParams.set('fixture', partida.api_football_id);

  console.log(`=== Chamando: ${url.toString()} ===\n`);

  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();

  console.log('=== Resposta HTTP ===');
  console.log('Status:', res.status, res.statusText);
  console.log('');
  console.log('=== Corpo completo da resposta ===');
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
