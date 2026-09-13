/**
 * testar-odds.js
 *
 * Testa se a API-Football (que já pagamos, plano Pro) retorna dado de odds
 * de verdade pro seu plano -- antes de considerar assinar um provedor
 * separado só pra isso.
 *
 * Uso:
 *   node scripts/testar-odds.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_FOOTBALL_KEY };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function apiFetch(endpoint, params = {}) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  return data;
}

async function main() {
  console.log('Buscando uma partida futura próxima pra testar odds...\n');

  const { data: partida } = await supabase
    .from('partidas')
    .select('id, api_football_id, data_hora, time_casa_id, time_fora_id')
    .eq('status', 'agendado')
    .gte('data_hora', new Date().toISOString())
    .order('data_hora', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!partida) {
    console.log('Nenhuma partida futura encontrada no banco pra testar.');
    return;
  }

  console.log(`Testando partida (api_football_id: ${partida.api_football_id}, data: ${new Date(partida.data_hora).toLocaleString('pt-BR')})\n`);

  console.log('=== 1. Endpoint /odds (odds pré-jogo) ===');
  const respostaOdds = await apiFetch('odds', { fixture: partida.api_football_id });
  console.log('Erros retornados pela API:', JSON.stringify(respostaOdds.errors));
  console.log('Quantidade de resultados:', respostaOdds.results);

  if (respostaOdds.response && respostaOdds.response.length > 0) {
    console.log('\n✅ TEM DADO! Amostra da estrutura retornada:\n');
    const primeiraCasa = respostaOdds.response[0];
    console.log('Bookmaker(s) disponíveis:', primeiraCasa.bookmakers?.map((b) => b.name).join(', '));
    if (primeiraCasa.bookmakers?.[0]) {
      console.log('\nMercados do primeiro bookmaker:');
      primeiraCasa.bookmakers[0].bets?.forEach((bet) => {
        console.log(`  - ${bet.name}: ${bet.values.map((v) => `${v.value}=${v.odd}`).join(', ')}`);
      });
    }
  } else {
    console.log('\n❌ SEM DADO pra essa partida específica (pode ser normal se o jogo for muito distante -- odds geralmente só ficam disponíveis mais perto do jogo).');
  }

  console.log('\n\n=== 2. Verificando se o endpoint existe pro seu plano (sem filtro de partida) ===');
  const hoje = new Date().toISOString().slice(0, 10);
  const respostaGeral = await apiFetch('odds', { date: hoje, league: 71, season: 2026 });
  console.log('Erros retornados pela API:', JSON.stringify(respostaGeral.errors));
  console.log('Quantidade de resultados (odds disponíveis hoje, Série A):', respostaGeral.results);

  if (respostaGeral.results > 0) {
    console.log('✅ O endpoint de odds está funcionando pro seu plano.');
  } else if (respostaGeral.errors && Object.keys(respostaGeral.errors).length > 0) {
    console.log('❌ O endpoint retornou erro -- provavelmente não está incluído no seu plano atual.');
  } else {
    console.log('⚠️  Endpoint respondeu sem erro, mas sem odds pra hoje -- pode ser só falta de jogo hoje mesmo, não necessariamente falta de acesso.');
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
