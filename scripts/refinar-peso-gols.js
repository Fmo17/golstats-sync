/**
 * refinar-peso-gols.js
 *
 * Busca fina (passo de 5%) só entre ataque-temporada e defesa-temporada --
 * já descartamos "últimos 5" no teste anterior. Mostra as 3 faixas
 * SEPARADAS pra cada peso testado, sem misturar numa média que esconde
 * perdas na faixa 3+ (que tem menos volume e fica mascarada em médias
 * gerais).
 *
 * Uso:
 *   node scripts/refinar-peso-gols.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MINIMO_JOGOS_TIME = 3;
const MINIMO_JOGOS_LIGA = 10;

function calcularDiff(partidasAnteriores, timeCasaId, timeForaId, tipo) {
  const jogosMandante = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId);
  const jogosVisitante = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId);
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
  console.log('Pré-calculando ataque e defesa (temporada inteira) pra todo o histórico...\n');

  const { data: competicoes } = await supabase.from('competicoes').select('id, nome').eq('ativa', true);

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
      const ataque = calcularDiff(historicoAntes, partida.time_casa_id, partida.time_fora_id, 'ataque');
      const defesa = calcularDiff(historicoAntes, partida.time_casa_id, partida.time_fora_id, 'defesa');
      if (ataque === null || defesa === null) continue;
      casos.push({ ataque, defesa, golsTotais: partida.gols_casa + partida.gols_fora });
    }
  }

  console.log(`${casos.length} jogos prontos.\n`);
  console.log('Peso ataque | 3+ (acerto / volume) | 2+ (acerto / volume) | 1+ (acerto / volume) | Volume total\n');

  for (let wAtaque = 0; wAtaque <= 1.0001; wAtaque += 0.05) {
    const w = Math.round(wAtaque * 100) / 100;
    const wDefesa = 1 - w;
    const resultados = { '3mais': { total: 0, acertos: 0 }, '2mais': { total: 0, acertos: 0 }, '1mais': { total: 0, acertos: 0 } };

    for (const caso of casos) {
      const diffCombinado = caso.ataque * w + caso.defesa * wDefesa;
      const faixa = classificarFaixa(diffCombinado);
      if (!faixa) continue;
      const acertou = bateuFaixa(faixa, caso.golsTotais);
      resultados[faixa].total++;
      if (acertou) resultados[faixa].acertos++;
    }

    const totalSinais = Object.values(resultados).reduce((s, r) => s + r.total, 0);
    const f3 = resultados['3mais'], f2 = resultados['2mais'], f1 = resultados['1mais'];
    const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : '--');

    console.log(
      `${w.toFixed(2)}  |  3+: ${pct(f3.acertos, f3.total)}% (${f3.total})  |  2+: ${pct(f2.acertos, f2.total)}% (${f2.total})  |  1+: ${pct(f1.acertos, f1.total)}% (${f1.total})  |  vol: ${((totalSinais / casos.length) * 100).toFixed(1)}%`
    );
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
