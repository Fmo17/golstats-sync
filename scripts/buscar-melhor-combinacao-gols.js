/**
 * buscar-melhor-combinacao-gols.js
 *
 * Busca sistemática: pré-calcula os 4 indicadores base (ataque-temporada,
 * ataque-últimos5, defesa-temporada, defesa-últimos5) pra TODO o histórico
 * uma vez só, depois testa uma grade de combinações de peso entre eles,
 * rankeando pela taxa de acerto GERAL (soma de acertos / soma de sinais,
 * nas 3 faixas juntas) -- e mostra volume de cada uma, pra decisão final
 * considerar as 2 coisas, não só taxa de acerto isolada.
 *
 * Uso:
 *   node scripts/buscar-melhor-combinacao-gols.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MINIMO_JOGOS_TIME = 3;
const MINIMO_JOGOS_LIGA = 10;
const JANELA_CURTA = 5;

function calcularDiff(partidasAnteriores, timeCasaId, timeForaId, tipo, janela) {
  let jogosMandante = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId);
  let jogosVisitante = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId);
  if (janela !== null) { jogosMandante = jogosMandante.slice(-janela); jogosVisitante = jogosVisitante.slice(-janela); }
  if (jogosMandante.length < MINIMO_JOGOS_TIME || jogosVisitante.length < MINIMO_JOGOS_TIME) return null;

  const campoMandante = tipo === 'ataque' ? 'gols_casa' : 'gols_fora';
  const campoVisitante = tipo === 'ataque' ? 'gols_fora' : 'gols_casa';
  const mediaMandante = jogosMandante.reduce((s, p) => s + p[campoMandante], 0) / jogosMandante.length;
  const mediaVisitante = jogosVisitante.reduce((s, p) => s + p[campoVisitante], 0) / jogosVisitante.length;

  if (partidasAnteriores.length < MINIMO_JOGOS_LIGA) return null;
  const mediaLigaTotal = partidasAnteriores.reduce((s, p) => s + p.gols_casa + p.gols_fora, 0) / partidasAnteriores.length;
  const mediaLiga = mediaLigaTotal / 2;
  const mediaConfronto = (mediaMandante + mediaVisitante) / 2;
  return ((mediaConfronto - mediaLiga) / mediaLiga) * 100;
}

function classificarFaixa(d) {
  if (d > 30) return '3mais';
  if (d > 10) return '2mais';
  if (d >= -10) return '1mais';
  return null;
}
function bateuFaixa(faixa, golsTotais) {
  if (faixa === '3mais') return golsTotais >= 3;
  if (faixa === '2mais') return golsTotais >= 2;
  if (faixa === '1mais') return golsTotais >= 1;
  return null;
}

async function main() {
  console.log('Carregando e pré-calculando os 4 indicadores pra todo o histórico (pode demorar um pouco)...\n');

  const { data: competicoes } = await supabase.from('competicoes').select('id, nome').eq('ativa', true);

  // Pré-calcula os 4 indicadores + resultado real de cada jogo, UMA VEZ
  const casos = [];
  for (const comp of competicoes) {
    const { data: partidas } = await supabase
      .from('partidas')
      .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
      .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
      .order('data_hora', { ascending: true });
    if (!partidas || partidas.length < 40) continue;

    for (let i = 0; i < partidas.length; i++) {
      const partida = partidas[i];
      const historicoAntes = partidas.slice(0, i);

      const ataqueTemp = calcularDiff(historicoAntes, partida.time_casa_id, partida.time_fora_id, 'ataque', null);
      const ataqueUlt5 = calcularDiff(historicoAntes, partida.time_casa_id, partida.time_fora_id, 'ataque', JANELA_CURTA);
      const defesaTemp = calcularDiff(historicoAntes, partida.time_casa_id, partida.time_fora_id, 'defesa', null);
      const defesaUlt5 = calcularDiff(historicoAntes, partida.time_casa_id, partida.time_fora_id, 'defesa', JANELA_CURTA);

      if (ataqueTemp === null || ataqueUlt5 === null || defesaTemp === null || defesaUlt5 === null) continue;

      casos.push({ ataqueTemp, ataqueUlt5, defesaTemp, defesaUlt5, golsTotais: partida.gols_casa + partida.gols_fora });
    }
  }

  console.log(`${casos.length} jogos com os 4 indicadores calculáveis.\n`);

  // Grade de pesos a testar -- cada combinação soma 1.0
  const PASSO = 0.25;
  const candidatos = [];
  for (let wAT = 0; wAT <= 1; wAT += PASSO) {
    for (let wAU = 0; wAU <= 1 - wAT; wAU += PASSO) {
      for (let wDT = 0; wDT <= 1 - wAT - wAU; wDT += PASSO) {
        const wDU = 1 - wAT - wAU - wDT;
        if (wDU < -0.001) continue;
        candidatos.push({ wAT: Math.round(wAT * 100) / 100, wAU: Math.round(wAU * 100) / 100, wDT: Math.round(wDT * 100) / 100, wDU: Math.round(wDU * 100) / 100 });
      }
    }
  }

  console.log(`Testando ${candidatos.length} combinações de peso...\n`);

  const resultadosPorCombinacao = [];

  for (const c of candidatos) {
    const resultados = { '3mais': { total: 0, acertos: 0 }, '2mais': { total: 0, acertos: 0 }, '1mais': { total: 0, acertos: 0 } };

    for (const caso of casos) {
      const diffCombinado = caso.ataqueTemp * c.wAT + caso.ataqueUlt5 * c.wAU + caso.defesaTemp * c.wDT + caso.defesaUlt5 * c.wDU;
      const faixa = classificarFaixa(diffCombinado);
      if (!faixa) continue;
      const acertou = bateuFaixa(faixa, caso.golsTotais);
      resultados[faixa].total++;
      if (acertou) resultados[faixa].acertos++;
    }

    const totalSinais = Object.values(resultados).reduce((s, r) => s + r.total, 0);
    const totalAcertos = Object.values(resultados).reduce((s, r) => s + r.acertos, 0);
    if (totalSinais < 500) continue; // ignora combinações que geram sinal de menos (não comparável)

    resultadosPorCombinacao.push({
      pesos: c,
      taxaGeral: totalAcertos / totalSinais,
      volume: totalSinais / casos.length,
      porFaixa: resultados,
    });
  }

  resultadosPorCombinacao.sort((a, b) => b.taxaGeral - a.taxaGeral);

  console.log('=== TOP 10 combinações, por taxa de acerto geral (3 faixas somadas) ===\n');
  console.log('(wAT=ataque temporada, wAU=ataque últimos5, wDT=defesa temporada, wDU=defesa últimos5)\n');

  for (const r of resultadosPorCombinacao.slice(0, 10)) {
    const p = r.pesos;
    console.log(`Pesos: ataqueTemp=${p.wAT} ataqueUlt5=${p.wAU} defesaTemp=${p.wDT} defesaUlt5=${p.wDU}`);
    console.log(`  Taxa geral: ${(r.taxaGeral * 100).toFixed(1)}%  |  Volume: ${(r.volume * 100).toFixed(1)}% dos jogos`);
    for (const [faixaNome, dados] of Object.entries(r.porFaixa)) {
      if (dados.total === 0) continue;
      console.log(`    ${faixaNome}: ${dados.acertos}/${dados.total} (${((dados.acertos / dados.total) * 100).toFixed(1)}%)`);
    }
    console.log('');
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
