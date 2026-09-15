/**
 * sync-odds.js
 *
 * Busca odds reais (várias casas de apostas) pros jogos futuros dentro da
 * janela de sinais, e grava em odds_historico. Roda repetidamente ao longo
 * do tempo (não faz upsert) -- cada execução grava uma "foto" nova da odd
 * naquele momento, construindo histórico de como ela mudou até o jogo.
 *
 * Uso:
 *   node scripts/sync-odds.js [--limite=50] [--pausa=1000] [--dias=5]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_FOOTBALL_KEY };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function apiFetch(endpoint, params = {}) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football: ${JSON.stringify(data.errors)}`);
  }
  return data.response || [];
}

/**
 * Extrai o valor de odd de um bet específico, pelo nome do mercado e do
 * "value" dentro dele (formato da API: bets: [{ name, values: [{value, odd}] }]).
 */
function extrairOdd(bets, nomeMercado, nomeValor) {
  const bet = bets.find((b) => b.name === nomeMercado);
  if (!bet) return null;
  const valor = bet.values.find((v) => v.value === nomeValor);
  return valor ? parseFloat(valor.odd) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const apenasHoje = args.includes('--apenas-hoje');
  const limite = args.find((a) => a.startsWith('--limite=')) ? parseInt(args.find((a) => a.startsWith('--limite=')).split('=')[1], 10) : 1000;
  const pausa = args.find((a) => a.startsWith('--pausa=')) ? parseInt(args.find((a) => a.startsWith('--pausa=')).split('=')[1], 10) : 1000;
  const dias = args.find((a) => a.startsWith('--dias=')) ? parseInt(args.find((a) => a.startsWith('--dias=')).split('=')[1], 10) : 5;

  let dataInicio, dataFim, descricaoJanela;

  if (apenasHoje) {
    const agora = new Date();
    dataInicio = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 0, 0, 0)).toISOString();
    dataFim = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 23, 59, 59)).toISOString();
    descricaoJanela = 'só os jogos de HOJE';
  } else {
    dataInicio = new Date().toISOString();
    dataFim = new Date(Date.now() + dias * 86400000).toISOString();
    descricaoJanela = `próximos ${dias} dias`;
  }

  console.log(`Buscando partidas agendadas (${descricaoJanela}, limite: ${limite} partidas)...\n`);

  const { data: partidas, error } = await supabase
    .from('partidas')
    .select('id, api_football_id, data_hora, time_casa_id, time_fora_id')
    .eq('status', 'agendado')
    .gte('data_hora', dataInicio)
    .lte('data_hora', dataFim)
    .order('data_hora', { ascending: true })
    .limit(limite);

  if (error) throw error;
  if (!partidas || partidas.length === 0) {
    console.log('Nenhuma partida futura encontrada dentro da janela.');
    return;
  }

  console.log(`${partidas.length} partidas selecionadas.\n`);

  let partidasComOdds = 0;
  let linhasGravadas = 0;
  let erros = 0;

  for (const partida of partidas) {
    try {
      await sleep(pausa);

      const response = await apiFetch('odds', { fixture: partida.api_football_id });

      if (!response || response.length === 0) continue; // sem odds disponível ainda pra esse jogo (normal se for muito distante)

      const bookmakers = response[0].bookmakers || [];
      if (bookmakers.length === 0) continue;

      partidasComOdds++;

      for (const bookmaker of bookmakers) {
        const bets = bookmaker.bets || [];

        const registro = {
          partida_id: partida.id,
          casa_apostas: bookmaker.name,
          odd_casa: extrairOdd(bets, 'Match Winner', 'Home'),
          odd_empate: extrairOdd(bets, 'Match Winner', 'Draw'),
          odd_fora: extrairOdd(bets, 'Match Winner', 'Away'),
          odd_dupla_1x: extrairOdd(bets, 'Double Chance', 'Home/Draw'),
          odd_dupla_x2: extrairOdd(bets, 'Double Chance', 'Draw/Away'),
          odd_over_05: extrairOdd(bets, 'Goals Over/Under', 'Over 0.5'),
          odd_over_15: extrairOdd(bets, 'Goals Over/Under', 'Over 1.5'),
          odd_over_25: extrairOdd(bets, 'Goals Over/Under', 'Over 2.5'),
        };

        // Só grava se pelo menos alguma odd relevante veio preenchida
        const temAlgumaOdd = [registro.odd_casa, registro.odd_dupla_1x, registro.odd_dupla_x2, registro.odd_over_05, registro.odd_over_15, registro.odd_over_25].some((v) => v !== null);
        if (!temAlgumaOdd) continue;

        const { error: erroInsert } = await supabase.from('odds_historico').insert(registro);
        if (erroInsert) {
          erros++;
          console.error(`  Erro ao gravar odd (partida ${partida.id}, ${bookmaker.name}):`, erroInsert.message);
        } else {
          linhasGravadas++;
        }
      }
    } catch (err) {
      erros++;
      console.error(`  Erro na partida ${partida.api_football_id}:`, err.message);
    }
  }

  console.log(`\n=== Sync de odds finalizado ===`);
  console.log(`Partidas com odds encontradas: ${partidasComOdds} de ${partidas.length}`);
  console.log(`Linhas gravadas em odds_historico: ${linhasGravadas}`);
  if (erros > 0) console.log(`⚠️  Erros: ${erros}`);
}

main().catch((err) => { console.error('Erro fatal:', err); process.exit(1); });
