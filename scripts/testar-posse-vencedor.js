/**
 * testar-posse-vencedor.js
 *
 * Testa a hipótese: se a média histórica de posse de bola de um time é
 * mais de 10 pontos percentuais maior que a do adversário, esse time
 * tende a vencer a partida.
 *
 * Restrito à Série A (única com cobertura de posse de bola passando de
 * 300 jogos). Usa temporada inteira como janela (validada como boa opção
 * nos testes de gols).
 *
 * Uso:
 *   node scripts/testar-posse-vencedor.js [--limiar=10]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const MINIMO_JOGOS_TIME = 3;
const COMPETICOES_QUALIFICADAS = ['Brasileirão Série A', 'Brasileirão Série B'];

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
  const limiarArg = args.find((a) => a.startsWith('--limiar='));
  const LIMIAR = limiarArg ? parseFloat(limiarArg.split('=')[1]) : 10;
  const janelaArg = args.find((a) => a.startsWith('--janela='));
  const JANELA = janelaArg ? parseInt(janelaArg.split('=')[1], 10) : null; // null = temporada inteira

  let totalComOsDois = 0;
  let totalComSinal = 0;
  const grupoMandante = { acertos: 0, empates: 0, erros: 0, total: 0 };
  const grupoVisitante = { acertos: 0, empates: 0, erros: 0, total: 0 };
  let baseVitoriaMandante = 0, baseVitoriaVisitante = 0, baseEmpate = 0, baseTotal = 0;

  for (const nomeCompeticao of COMPETICOES_QUALIFICADAS) {
    const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('nome', nomeCompeticao).single();

    const partidas = await buscarTudoPaginado(
      supabase.from('partidas').select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
        .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null).order('data_hora', { ascending: true })
    );

    const idsPartidas = partidas.map((p) => p.id);
    let stats = [];
    for (let i = 0; i < idsPartidas.length; i += 500) {
      const lote = idsPartidas.slice(i, i + 500);
      const parcial = await buscarTudoPaginado(supabase.from('estatisticas_partida').select('partida_id, time_id, posse_bola').in('partida_id', lote));
      stats = stats.concat(parcial);
    }

    const posseParcidaTime = {};
    for (const s of stats) {
      if (s.posse_bola === null) continue;
      if (!posseParcidaTime[s.partida_id]) posseParcidaTime[s.partida_id] = {};
      posseParcidaTime[s.partida_id][s.time_id] = s.posse_bola;
    }

    console.log(`${nomeCompeticao}: ${partidas.length} jogos`);

    for (let i = 0; i < partidas.length; i++) {
      const partida = partidas[i];
      baseTotal++;
      if (partida.gols_casa > partida.gols_fora) baseVitoriaMandante++;
      else if (partida.gols_casa < partida.gols_fora) baseVitoriaVisitante++;
      else baseEmpate++;

      const historicoAntes = partidas.slice(0, i);

      const jogosMandante = historicoAntes.filter((p) => p.time_casa_id === partida.time_casa_id && posseParcidaTime[p.id]?.[p.time_casa_id] !== undefined);
      const jogosVisitante = historicoAntes.filter((p) => p.time_fora_id === partida.time_fora_id && posseParcidaTime[p.id]?.[p.time_fora_id] !== undefined);
      const jogosMandanteJanela = JANELA !== null ? jogosMandante.slice(-JANELA) : jogosMandante;
      const jogosVisitanteJanela = JANELA !== null ? jogosVisitante.slice(-JANELA) : jogosVisitante;
      if (jogosMandanteJanela.length < MINIMO_JOGOS_TIME || jogosVisitanteJanela.length < MINIMO_JOGOS_TIME) continue;

      const mediaPosseMandante = jogosMandanteJanela.reduce((s, p) => s + posseParcidaTime[p.id][p.time_casa_id], 0) / jogosMandanteJanela.length;
      const mediaPosseVisitante = jogosVisitanteJanela.reduce((s, p) => s + posseParcidaTime[p.id][p.time_fora_id], 0) / jogosVisitanteJanela.length;

      totalComOsDois++;
      const diferenca = mediaPosseMandante - mediaPosseVisitante;
      if (Math.abs(diferenca) <= LIMIAR) continue;

      totalComSinal++;
      const previstoVencedor = diferenca > 0 ? 'mandante' : 'visitante';
      const resultadoReal = partida.gols_casa > partida.gols_fora ? 'mandante' : partida.gols_casa < partida.gols_fora ? 'visitante' : 'empate';

      const grupo = previstoVencedor === 'mandante' ? grupoMandante : grupoVisitante;
      grupo.total++;
      if (resultadoReal === previstoVencedor) grupo.acertos++;
      else if (resultadoReal === 'empate') grupo.empates++;
      else grupo.erros++;
    }
  }

  console.log(`\nTotal combinado (${COMPETICOES_QUALIFICADAS.join(' + ')}), limiar de ${LIMIAR} pontos, janela: ${JANELA !== null ? `últimos ${JANELA} jogos` : 'temporada inteira'}.\n`);
  console.log(`Jogos com os 2 times tendo histórico suficiente: ${totalComOsDois}`);
  console.log(`Jogos com diferença de posse > ${LIMIAR} pontos (sinal gerado): ${totalComSinal} (${((totalComSinal / totalComOsDois) * 100).toFixed(1)}%)\n`);

  console.log('=== Referência: taxa NORMAL de resultado na competição (sem filtro de posse) ===');
  console.log(`  Vitória mandante: ${baseVitoriaMandante}/${baseTotal} (${((baseVitoriaMandante / baseTotal) * 100).toFixed(1)}%)`);
  console.log(`  Vitória visitante: ${baseVitoriaVisitante}/${baseTotal} (${((baseVitoriaVisitante / baseTotal) * 100).toFixed(1)}%)`);
  console.log(`  Empate: ${baseEmpate}/${baseTotal} (${((baseEmpate / baseTotal) * 100).toFixed(1)}%)\n`);

  function relatarGrupo(nome, grupo, baseVitoriaComparavel) {
    if (grupo.total === 0) { console.log(`  ${nome}: sem casos`); return; }
    const taxaComEmpates = (grupo.acertos / grupo.total) * 100;
    const decisivos = grupo.acertos + grupo.erros;
    const taxaSemEmpates = decisivos > 0 ? (grupo.acertos / decisivos) * 100 : null;
    console.log(`  ${nome} (${grupo.total} casos):`);
    console.log(`    Acerto (com empate como "não acerto"): ${grupo.acertos}/${grupo.total} (${taxaComEmpates.toFixed(1)}%)`);
    if (taxaSemEmpates !== null) console.log(`    Acerto (só decisivos, sem empate): ${grupo.acertos}/${decisivos} (${taxaSemEmpates.toFixed(1)}%)`);
    console.log(`    Referência normal dessa direção (sem olhar posse): ${baseVitoriaComparavel.toFixed(1)}%`);
    if (grupo.total < 60) console.log(`    ⚠️  amostra pequena`);
    console.log('');
  }

  console.log('=== Quando a posse aponta pro MANDANTE ===');
  relatarGrupo('Mandante previsto', grupoMandante, (baseVitoriaMandante / baseTotal) * 100);

  console.log('=== Quando a posse aponta pro VISITANTE ===');
  relatarGrupo('Visitante previsto', grupoVisitante, (baseVitoriaVisitante / baseTotal) * 100);

  console.log('(Se a taxa de acerto de cada grupo for bem maior que a referência normal daquela direção,');
  console.log('é evidência real de que a posse adiciona informação -- não é só o fator casa disfarçado.)');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
