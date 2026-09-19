/**
 * testar-janelas-gols.js
 *
 * Testa 4 variações ISOLADAS do indicador de gols, cruzando janela de
 * tempo (temporada inteira vs últimos 5 jogos) com tipo de estatística
 * (ataque = gols feitos, defesa = gols sofridos):
 *
 *   1. Ataque, temporada inteira
 *   2. Ataque, últimos 5 jogos
 *   3. Defesa, temporada inteira
 *   4. Defesa, últimos 5 jogos
 *
 * Mesma lógica de sempre: soma a média do mandante com a do visitante,
 * divide por 2, compara com a média da competição (a mesma origem de
 * jogos usada em cada teste, pra ser justo).
 *
 * Uso:
 *   node scripts/testar-janelas-gols.js [--competicao=71]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MINIMO_JOGOS_TIME = 3;
const MINIMO_JOGOS_LIGA = 10;
const JANELA_CURTA = 5;

// tipo: 'ataque' (gols feitos) ou 'defesa' (gols sofridos)
// janela: número de jogos mais recentes, ou null = temporada inteira (todo o historicoAntes)
function calcularDiffPercentual(partidasAnteriores, timeCasaId, timeForaId, tipo, janela) {
  let jogosMandante = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId);
  let jogosVisitante = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId);
  if (janela !== null) {
    jogosMandante = jogosMandante.slice(-janela);
    jogosVisitante = jogosVisitante.slice(-janela);
  }
  if (jogosMandante.length < MINIMO_JOGOS_TIME || jogosVisitante.length < MINIMO_JOGOS_TIME) return null;

  const campoMandante = tipo === 'ataque' ? 'gols_casa' : 'gols_fora'; // ataque do mandante = gols que ele fez em casa; defesa = gols que sofreu em casa
  const campoVisitante = tipo === 'ataque' ? 'gols_fora' : 'gols_casa';

  const mediaMandante = jogosMandante.reduce((s, p) => s + p[campoMandante], 0) / jogosMandante.length;
  const mediaVisitante = jogosVisitante.reduce((s, p) => s + p[campoVisitante], 0) / jogosVisitante.length;

  if (partidasAnteriores.length < MINIMO_JOGOS_LIGA) return null;
  const mediaLigaTotal = partidasAnteriores.reduce((s, p) => s + p.gols_casa + p.gols_fora, 0) / partidasAnteriores.length;
  const mediaLiga = mediaLigaTotal / 2;
  const mediaConfronto = (mediaMandante + mediaVisitante) / 2;

  return ((mediaConfronto - mediaLiga) / mediaLiga) * 100;
}

function classificarFaixa(diffPercentual) {
  if (diffPercentual > 30) return '3mais';
  if (diffPercentual > 10) return '2mais';
  if (diffPercentual >= -10) return '1mais';
  return null;
}

function bateuFaixa(faixa, golsTotais) {
  if (faixa === '3mais') return golsTotais >= 3;
  if (faixa === '2mais') return golsTotais >= 2;
  if (faixa === '1mais') return golsTotais >= 1;
  return null;
}

const VARIANTES = [
  { nome: 'Ataque, temporada inteira', tipo: 'ataque', janela: null },
  { nome: 'Ataque, últimos 5 jogos', tipo: 'ataque', janela: JANELA_CURTA },
  { nome: 'Defesa, temporada inteira', tipo: 'defesa', janela: null },
  { nome: 'Defesa, últimos 5 jogos', tipo: 'defesa', janela: JANELA_CURTA },
];

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const competicaoId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : null;

  const { data: competicoes } = await supabase
    .from('competicoes')
    .select('id, nome, api_football_id')
    .eq('ativa', true)
    .order('nome');

  const competicoesParaTestar = competicaoId ? competicoes.filter((c) => c.api_football_id === competicaoId) : competicoes;

  // Carrega os jogos de cada competição UMA VEZ, reaproveita pras 4 variantes
  const partidasPorCompeticao = {};
  for (const comp of competicoesParaTestar) {
    const { data: partidas } = await supabase
      .from('partidas')
      .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
      .eq('competicao_id', comp.id)
      .eq('status', 'finalizado')
      .not('gols_casa', 'is', null)
      .order('data_hora', { ascending: true });
    if (partidas && partidas.length >= 40) partidasPorCompeticao[comp.id] = { nome: comp.nome, partidas };
  }

  for (const variante of VARIANTES) {
    const resultadosGlobais = { '3mais': { total: 0, acertos: 0 }, '2mais': { total: 0, acertos: 0 }, '1mais': { total: 0, acertos: 0 } };
    let totalComIndicador = 0;

    for (const { partidas } of Object.values(partidasPorCompeticao)) {
      for (let i = 0; i < partidas.length; i++) {
        const partida = partidas[i];
        const historicoAntes = partidas.slice(0, i);

        const diff = calcularDiffPercentual(historicoAntes, partida.time_casa_id, partida.time_fora_id, variante.tipo, variante.janela);
        if (diff === null) continue;
        totalComIndicador++;

        const faixa = classificarFaixa(diff);
        if (!faixa) continue;

        const golsTotais = partida.gols_casa + partida.gols_fora;
        const acertou = bateuFaixa(faixa, golsTotais);
        resultadosGlobais[faixa].total++;
        if (acertou) resultadosGlobais[faixa].acertos++;
      }
    }

    const totalComFaixa = Object.values(resultadosGlobais).reduce((s, r) => s + r.total, 0);
    console.log(`\n=== ${variante.nome} ===`);
    for (const [faixaNome, dados] of Object.entries(resultadosGlobais)) {
      if (dados.total === 0) { console.log(`  ${faixaNome}: sem casos`); continue; }
      const taxa = (dados.acertos / dados.total) * 100;
      const aviso = dados.total < 60 ? '  ⚠️  amostra pequena' : '';
      console.log(`  ${faixaNome}: ${dados.acertos}/${dados.total} (${taxa.toFixed(1)}%)${aviso}`);
    }
    console.log(`  Volume: ${totalComFaixa}/${totalComIndicador} jogos com sinal (${((totalComFaixa / totalComIndicador) * 100).toFixed(1)}%)`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
