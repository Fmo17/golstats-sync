/**
 * checar-cobertura-paises.js
 *
 * Confirma com dado REAL da API-Football quais ligas estão disponíveis nos
 * países que você quer trabalhar -- em vez de confiar em "eu acho que sim".
 *
 * Uso:
 *   node scripts/checar-cobertura-paises.js
 */

import 'dotenv/config';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_FOOTBALL_KEY };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const PAISES_INTERESSE = [
  { pais: 'Brazil', ligaDesejada: ['Serie A', 'Serie B'] },
  { pais: 'Germany', ligaDesejada: ['Bundesliga'] },
  { pais: 'Italy', ligaDesejada: ['Serie A'] },
  { pais: 'France', ligaDesejada: ['Ligue 1'] },
  { pais: 'Spain', ligaDesejada: ['La Liga'] },
  { pais: 'England', ligaDesejada: ['Premier League'] },
  { pais: 'Portugal', ligaDesejada: ['Primeira Liga'] },
  { pais: 'USA', ligaDesejada: ['MLS', 'Major League Soccer'] },
  { pais: 'Saudi-Arabia', ligaDesejada: ['Pro League', 'Saudi'] },
  { pais: 'Argentina', ligaDesejada: ['Liga Profesional', 'Primera Division'] },
];

async function buscarLigasDoPais(pais) {
  const url = new URL(`${API_BASE}/leagues`);
  url.searchParams.set('country', pais);
  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();

  if (data.errors && Object.keys(data.errors).length > 0) {
    console.log(`  ERRO: ${JSON.stringify(data.errors)}`);
    return [];
  }
  return data.response || [];
}

async function main() {
  console.log('Confirmando cobertura real da API-Football por país...\n');

  for (const item of PAISES_INTERESSE) {
    console.log(`=== ${item.pais} ===`);
    const ligas = await buscarLigasDoPais(item.pais);

    if (ligas.length === 0) {
      console.log('  Nenhuma liga encontrada (país não coberto, ou erro na chamada).\n');
      await sleep(6500);
      continue;
    }

    const relevantes = ligas.filter((l) =>
      item.ligaDesejada.some((nome) => l.league.name.toLowerCase().includes(nome.toLowerCase()))
    );

    if (relevantes.length > 0) {
      for (const l of relevantes) {
        const temporadasDisponiveis = l.seasons.map((s) => s.year).join(', ');
        console.log(`  ✅ ${l.league.name} (id ${l.league.id}) -- temporadas disponíveis: ${temporadasDisponiveis}`);
      }
    } else {
      console.log(`  ❌ Não encontrei liga com nome parecido com: ${item.ligaDesejada.join(' / ')}`);
      console.log(`  Ligas encontradas nesse país (${ligas.length} total): ${ligas.slice(0, 5).map((l) => l.league.name).join(', ')}${ligas.length > 5 ? '...' : ''}`);
    }
    console.log('');

    await sleep(6500); // respeita o limite de 10 req/min do plano Free
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
