/**
 * scripts/gerar-dataset-calibracao.js
 *
 * ETAPA 1 do experimento offline de calibração (Platt scaling) -- gera um
 * dataset walk-forward com as probabilidades BRUTAS do Poisson e o
 * resultado REAL de cada partida, pra treinar e avaliar um calibrador
 * depois. Não muda nada em produção, não mexe no schema -- só lê o
 * histórico e grava um arquivo local.
 *
 * Importante (conforme decidido com o ChatGPT): NENHUM filtro de limiar é
 * aplicado aqui -- inclui TODA partida onde o Poisson conseguiu calcular
 * uma probabilidade, mesmo que ela nunca teria passado no LIMIAR_1X=0.65
 * atual. Filtrar aqui enviesaria a calibração pra só uma fatia da
 * distribuição. O filtro de "isso vira sinal ou não" é decisão de PRODUÇÃO,
 * aplicada depois, nunca durante a calibração.
 *
 * Uso:
 *   node scripts/gerar-dataset-calibracao.js [--competicao=71]
 *   (sem --competicao, roda em todas as competições ativas)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { preverConfronto, partidasAntesDe } from './lib/poisson.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function buscarTudoPaginado(query) {
  const TAMANHO_PAGINA = 1000;
  let pagina = 0;
  let todos = [];
  while (true) {
    const { data, error } = await query.range(pagina * TAMANHO_PAGINA, pagina * TAMANHO_PAGINA + TAMANHO_PAGINA - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    todos = todos.concat(data);
    if (data.length < TAMANHO_PAGINA) break;
    pagina++;
  }
  return todos;
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballIdFiltro = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : null;

  let query = supabase.from('competicoes').select('id, nome, api_football_id').eq('ativa', true);
  const { data: competicoes } = await query;
  const competicoesParaProcessar = apiFootballIdFiltro
    ? competicoes.filter((c) => c.api_football_id === apiFootballIdFiltro)
    : competicoes;

  const linhas = [];
  let totalPartidasElegiveis = 0;
  let totalSemDadoSuficiente = 0;

  for (const comp of competicoesParaProcessar) {
    const todasPartidas = await buscarTudoPaginado(
      supabase
        .from('partidas')
        .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
        .eq('competicao_id', comp.id)
        .eq('status', 'finalizado')
        .not('gols_casa', 'is', null)
        .order('data_hora', { ascending: true })
    );

    if (todasPartidas.length < 40) continue;

    console.log(`${comp.nome}: processando ${todasPartidas.length} partidas...`);

    // Não usa mais um corte artificial baseado em % do total (isso usava o
    // tamanho FINAL de cada competição, que só se conhece com o histórico
    // completo -- inconsistente com o que a produção realmente sabe no
    // momento de cada partida). Deixa a própria preverConfronto() decidir,
    // partida por partida, se já tem histórico suficiente (ela já devolve
    // null quando não tem).
    for (let i = 0; i < todasPartidas.length; i++) {
      const partida = todasPartidas[i];
      const anteriores = partidasAntesDe(todasPartidas, partida);

      const previsao = preverConfronto(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
      if (!previsao) { totalSemDadoSuficiente++; continue; }

      totalPartidasElegiveis++;

      const golsTotais = partida.gols_casa + partida.gols_fora;
      const real1X = partida.gols_casa >= partida.gols_fora; // casa ou empate
      const realX2 = partida.gols_casa <= partida.gols_fora; // empate ou fora

      linhas.push({
        partida_id: partida.id,
        competicao_id: comp.id,
        competicao_nome: comp.nome,
        data_hora: partida.data_hora,
        pCasa: previsao.pCasa,
        pEmpate: previsao.pEmpate,
        pFora: previsao.pFora,
        p1X: previsao.p1X,
        pX2: previsao.pX2,
        p12: previsao.p12,
        pOver05: previsao.pOver05,
        pOver15: previsao.pOver15,
        pOver25: previsao.pOver25,
        resultado_1X: real1X,
        resultado_X2: realX2,
        resultado_over05: golsTotais >= 1,
        resultado_over15: golsTotais >= 2,
        resultado_over25: golsTotais >= 3,
      });
    }
  }

  linhas.sort((a, b) => new Date(a.data_hora) - new Date(b.data_hora));

  const caminhoSaida = './experimentos/dataset-calibracao.json';
  writeFileSync(caminhoSaida, JSON.stringify(linhas, null, 2));

  console.log(`\n=== Dataset gerado ===`);
  console.log(`Partidas elegíveis (com probabilidade calculável): ${totalPartidasElegiveis}`);
  console.log(`Partidas sem histórico suficiente (puladas): ${totalSemDadoSuficiente}`);
  console.log(`Salvo em: ${caminhoSaida}`);
  console.log(`\nPeríodo coberto: ${linhas[0]?.data_hora} até ${linhas[linhas.length - 1]?.data_hora}`);
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
