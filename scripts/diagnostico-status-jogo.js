/**
 * diagnostico-status-jogo.js
 *
 * Busca o status BRUTO que a API-Football retorna pra um jogo específico,
 * e compara com o que está gravado no nosso banco -- pra descobrir se tem
 * algum código de status "finalizado" que não estamos reconhecendo.
 *
 * Uso:
 *   node scripts/diagnostico-status-jogo.js --busca="Huracan,Racing"
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
  const args = process.argv.slice(2);
  const buscaArg = args.find((a) => a.startsWith('--busca='));
  const termos = buscaArg.split('=')[1].split(',').map((t) => t.trim().toLowerCase());

  const { data: times } = await supabase.from('times').select('id, nome');

  // Pra cada termo de busca, acha os times que combinam -- e depois procura
  // um jogo onde os dois lados batem com termos DIFERENTES (não o mesmo time
  // aparecendo duas vezes por coincidência de nome parecido).
  const gruposPorTermo = termos.map((termo) => times.filter((t) => t.nome.toLowerCase().includes(termo)));

  console.log('Times encontrados por termo:');
  gruposPorTermo.forEach((grupo, i) => console.log(`  "${termos[i]}": ${grupo.map((t) => t.nome).join(', ')}`));
  console.log('');

  if (gruposPorTermo.length < 2) {
    console.log('Preciso de pelo menos 2 termos de busca (--busca="time1,time2") pra achar o confronto certo.');
    return;
  }

  const idsGrupo1 = gruposPorTermo[0].map((t) => t.id);
  const idsGrupo2 = gruposPorTermo[1].map((t) => t.id);

  // Busca jogos onde um lado é do grupo 1 e o outro é do grupo 2 (nas duas
  // ordens possíveis: grupo1 em casa ou grupo2 em casa)
  const { data: partidasCandidatas } = await supabase
    .from('partidas')
    .select('id, api_football_id, data_hora, status, gols_casa, gols_fora, time_casa_id, time_fora_id')
    .or(
      idsGrupo1.map((id1) => idsGrupo2.map((id2) => `and(time_casa_id.eq.${id1},time_fora_id.eq.${id2})`).join(',')).join(',') +
      ',' +
      idsGrupo1.map((id1) => idsGrupo2.map((id2) => `and(time_casa_id.eq.${id2},time_fora_id.eq.${id1})`).join(',')).join(',')
    )
    .order('data_hora', { ascending: false })
    .limit(5);

  if (!partidasCandidatas || partidasCandidatas.length === 0) {
    console.log('Nenhum confronto encontrado entre esses 2 grupos de times.');
    return;
  }

  console.log(`${partidasCandidatas.length} confronto(s) encontrado(s):\n`);

  for (const p of partidasCandidatas) {
    console.log(`  id interno: ${p.id} | api_football_id: ${p.api_football_id} | status: "${p.status}" | placar: ${p.gols_casa}x${p.gols_fora} | data: ${new Date(p.data_hora).toLocaleString('pt-BR')}`);
  }
  console.log('');

  const partida = partidasCandidatas[0];

  console.log('=== Detalhe do mais recente (id interno ' + partida.id + ') ===');
  console.log(`  status: "${partida.status}"`);
  console.log(`  gols_casa: ${partida.gols_casa}, gols_fora: ${partida.gols_fora}`);
  console.log(`  data: ${new Date(partida.data_hora).toLocaleString('pt-BR')}\n`);

  // Verifica se existe algum SINAL apontando pra um id DIFERENTE do mais recente
  const idsCandidatos = partidasCandidatas.map((p) => p.id);
  const { data: sinaisLigados } = await supabase
    .from('sinais')
    .select('id, partida_id, tipo_mercado')
    .in('partida_id', idsCandidatos);

  if (sinaisLigados && sinaisLigados.length > 0) {
    console.log('=== Sinais existentes, ligados a qual id de partida ===');
    for (const s of sinaisLigados) {
      const pCorrespondente = partidasCandidatas.find((p) => p.id === s.partida_id);
      console.log(`  Sinal ${s.id} (${s.tipo_mercado}) -> partida_id ${s.partida_id} (status: "${pCorrespondente?.status}")`);
    }

    console.log('\n=== Esses sinais já têm resultado gravado em sinais_resultado? ===');
    const idsSinais = sinaisLigados.map((s) => s.id);
    const { data: resultadosGravados, error: erroResultados } = await supabase
      .from('sinais_resultado')
      .select('*')
      .in('sinal_id', idsSinais);

    if (erroResultados) {
      console.log('  Erro ao consultar sinais_resultado:', erroResultados.message);
    } else if (!resultadosGravados || resultadosGravados.length === 0) {
      console.log('  ❌ NENHUM resultado gravado ainda pra esses sinais -- confirma que realmente não foram conferidos.');
    } else {
      console.log(`  ✅ ${resultadosGravados.length} resultado(s) encontrado(s):`);
      for (const r of resultadosGravados) {
        console.log(`     ${JSON.stringify(r)}`);
      }
    }
  } else {
    console.log('Nenhum sinal encontrado ligado a nenhum desses confrontos.');
  }

  console.log('=== O que a API-Football retorna AGORA, direto na fonte ===');
  const resposta = await apiFetch('fixtures', { id: partida.api_football_id });

  if (!resposta.response || resposta.response.length === 0) {
    console.log('  A API não retornou nada pra esse fixture ID.');
    return;
  }

  const fx = resposta.response[0];
  console.log(`  status.short: "${fx.fixture.status.short}"`);
  console.log(`  status.long: "${fx.fixture.status.long}"`);
  console.log(`  placar retornado: ${fx.goals.home} x ${fx.goals.away}`);

  const finalizados = ['FT', 'AET', 'PEN', 'AWD', 'WO'];
  console.log(`\n  Esse código está na nossa lista de "finalizados"? ${finalizados.includes(fx.fixture.status.short) ? '✅ SIM' : '❌ NÃO -- aqui está o bug'}`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
