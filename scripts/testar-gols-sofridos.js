/**
 * testar-gols-sofridos.js
 *
 * Testa ISOLADAMENTE a lógica de "gols sofridos" pro mercado de gols --
 * mesma estrutura da regra percentual que já existe (baseada em ataque),
 * só que usando gols SOFRIDOS em vez de gols FEITOS:
 *
 *   médiaSofridosMandante = média de gols sofridos pelo mandante em casa
 *   médiaSofridosVisitante = média de gols sofridos pelo visitante fora
 *   médiaConfronto = (médiaSofridosMandante + médiaSofridosVisitante) / 2
 *   médiaLiga = média de gols por time da competição (igual já usamos)
 *   diffPercentual = ((médiaConfronto - médiaLiga) / médiaLiga) * 100
 *
 * Roda contra TODO o histórico já finalizado, comparando a faixa prevista
 * com o resultado real (quantos gols saíram no jogo) -- mede a taxa de
 * acerto de cada faixa, igual já fazemos pros outros mercados.
 *
 * Uso:
 *   node scripts/testar-gols-sofridos.js [--competicao=71]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const JANELA_GOLS = 10;
const MINIMO_JOGOS_TIME = 3;
const MINIMO_JOGOS_LIGA = 10;

function calcularDiffPercentualSofridos(partidasAnteriores, timeCasaId, timeForaId) {
  const jogosMandante = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId).slice(-JANELA_GOLS);
  if (jogosMandante.length < MINIMO_JOGOS_TIME) return null;
  // Gols sofridos pelo mandante jogando em casa = gols do visitante nesses jogos
  const mediaSofridosMandante = jogosMandante.reduce((s, p) => s + p.gols_fora, 0) / jogosMandante.length;

  const jogosVisitante = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId).slice(-JANELA_GOLS);
  if (jogosVisitante.length < MINIMO_JOGOS_TIME) return null;
  // Gols sofridos pelo visitante jogando fora = gols do mandante nesses jogos
  const mediaSofridosVisitante = jogosVisitante.reduce((s, p) => s + p.gols_casa, 0) / jogosVisitante.length;

  if (partidasAnteriores.length < MINIMO_JOGOS_LIGA) return null;
  const mediaLigaTotal = partidasAnteriores.reduce((s, p) => s + p.gols_casa + p.gols_fora, 0) / partidasAnteriores.length;
  const mediaLiga = mediaLigaTotal / 2;
  const mediaConfronto = (mediaSofridosMandante + mediaSofridosVisitante) / 2;

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

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const competicaoId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : null;
  const detalhado = args.includes('--detalhado');
  const limiteDetalhe = args.find((a) => a.startsWith('--limite='))
    ? parseInt(args.find((a) => a.startsWith('--limite=')).split('=')[1], 10)
    : 50;

  const { data: competicoes } = await supabase
    .from('competicoes')
    .select('id, nome, api_football_id')
    .eq('ativa', true)
    .order('nome');

  const competicoesParaTestar = competicaoId ? competicoes.filter((c) => c.api_football_id === competicaoId) : competicoes;

  const { data: todosOsTimes } = await supabase.from('times').select('id, nome');
  const nomePorTimeId = Object.fromEntries((todosOsTimes || []).map((t) => [t.id, t.nome]));

  const resultadosGlobais = { '3mais': { total: 0, acertos: 0 }, '2mais': { total: 0, acertos: 0 }, '1mais': { total: 0, acertos: 0 } };
  const todosOsJogosDetalhados = [];

  for (const comp of competicoesParaTestar) {
    const { data: partidas } = await supabase
      .from('partidas')
      .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
      .eq('competicao_id', comp.id)
      .eq('status', 'finalizado')
      .not('gols_casa', 'is', null)
      .order('data_hora', { ascending: true });

    if (!partidas || partidas.length < 40) continue;

    const resultadosComp = { '3mais': { total: 0, acertos: 0 }, '2mais': { total: 0, acertos: 0 }, '1mais': { total: 0, acertos: 0 } };

    for (let i = 0; i < partidas.length; i++) {
      const partida = partidas[i];
      const historicoAntes = partidas.slice(0, i); // só jogos anteriores, em ordem cronológica

      const diff = calcularDiffPercentualSofridos(historicoAntes, partida.time_casa_id, partida.time_fora_id);
      if (diff === null) continue;

      const faixa = classificarFaixa(diff);
      if (!faixa) continue;

      const golsTotais = partida.gols_casa + partida.gols_fora;
      const acertou = bateuFaixa(faixa, golsTotais);

      resultadosComp[faixa].total++;
      resultadosGlobais[faixa].total++;
      if (acertou) { resultadosComp[faixa].acertos++; resultadosGlobais[faixa].acertos++; }

      if (detalhado) {
        todosOsJogosDetalhados.push({
          competicao: comp.nome,
          dataHora: partida.data_hora,
          timeCasa: nomePorTimeId[partida.time_casa_id] || '?',
          timeFora: nomePorTimeId[partida.time_fora_id] || '?',
          golsCasa: partida.gols_casa,
          golsFora: partida.gols_fora,
          diff,
          faixa,
          acertou,
        });
      }
    }

    const totalComp = Object.values(resultadosComp).reduce((s, r) => s + r.total, 0);
    if (totalComp === 0) continue;

    console.log(`\n=== ${comp.nome} ===`);
    for (const [faixaNome, dados] of Object.entries(resultadosComp)) {
      if (dados.total === 0) { console.log(`  ${faixaNome}: sem casos`); continue; }
      const taxa = (dados.acertos / dados.total) * 100;
      const aviso = dados.total < 60 ? '  ⚠️  amostra pequena' : '';
      console.log(`  ${faixaNome}: ${dados.acertos}/${dados.total} (${taxa.toFixed(1)}%)${aviso}`);
    }
  }

  console.log('\n\n=== RESULTADO GLOBAL (todas as competições testadas somadas) ===');
  for (const [faixaNome, dados] of Object.entries(resultadosGlobais)) {
    if (dados.total === 0) { console.log(`  ${faixaNome}: sem casos`); continue; }
    const taxa = (dados.acertos / dados.total) * 100;
    const aviso = dados.total < 60 ? '  ⚠️  amostra pequena' : '';
    console.log(`  ${faixaNome}: ${dados.acertos}/${dados.total} (${taxa.toFixed(1)}%)${aviso}`);
  }

  if (detalhado) {
    const rotulos = { '3mais': 'Gols 3+', '2mais': 'Gols 2+', '1mais': 'Gols 1+' };
    const maisRecentes = [...todosOsJogosDetalhados].sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora)).slice(0, limiteDetalhe);

    console.log(`\n\n=== Detalhe jogo a jogo (${maisRecentes.length} mais recentes, de ${todosOsJogosDetalhados.length} testados) ===\n`);
    for (const j of maisRecentes) {
      const data = new Date(j.dataHora).toLocaleDateString('pt-BR');
      const simbolo = j.acertou ? '✅' : '❌';
      console.log(`${simbolo} [${j.competicao}] ${j.timeCasa} ${j.golsCasa} x ${j.golsFora} ${j.timeFora} (${data})`);
      console.log(`   Previsto: ${rotulos[j.faixa]} (diff sofridos: ${j.diff.toFixed(1)}%)  |  Gols reais no jogo: ${j.golsCasa + j.golsFora}\n`);
    }
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
