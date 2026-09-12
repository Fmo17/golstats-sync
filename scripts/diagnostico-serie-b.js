/**
 * diagnostico-serie-b.js
 *
 * Investiga por que a Série B não mostra crescimento de cobertura mesmo
 * depois de gravações "bem-sucedidas" -- mostra o conteúdo REAL das últimas
 * linhas gravadas, campo por campo, pra ver se estão vindo vazias (null).
 *
 * Uso:
 *   node scripts/diagnostico-serie-b.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  const args = process.argv.slice(2);
  const idsArg = args.find((a) => a.startsWith('--ids='));

  // Total de linhas na tabela inteira, sem filtro nenhum -- só pra confirmar
  // se o número geral de registros cresceu de verdade.
  const { count: totalGeral } = await supabase
    .from('estatisticas_partida')
    .select('*', { count: 'exact', head: true });
  console.log(`Total de linhas em estatisticas_partida (tabela inteira, sem filtro): ${totalGeral}\n`);

  // Busca a competição Série B
  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', 72).single();
  console.log(`Série B -- id interno: ${comp.id}\n`);

  // Pega as partidas da Série B
  const { data: partidasSerieB } = await supabase
    .from('partidas')
    .select('id, status')
    .eq('competicao_id', comp.id)
    .limit(1000);

  const idsSerieB = partidasSerieB.map((p) => p.id);
  console.log(`Partidas da Série B no banco (qualquer status): ${partidasSerieB.length}`);
  console.log(`  Status 'finalizado': ${partidasSerieB.filter((p) => p.status === 'finalizado').length}\n`);

  // Se foi passado --ids=, consulta exatamente esses IDs (o jeito mais
  // confiável de conferir um lote específico que acabou de ser processado).
  if (idsArg) {
    const idsAlvo = idsArg.split('=')[1].split(',').map((x) => parseInt(x, 10));
    console.log(`Consultando especificamente os IDs: ${idsAlvo.join(', ')}\n`);

    const { data: linhasAlvo } = await supabase
      .from('estatisticas_partida')
      .select('*')
      .in('partida_id', idsAlvo);

    console.log(`Linhas encontradas pra esses IDs específicos: ${linhasAlvo.length}\n`);
    for (const s of linhasAlvo) {
      console.log(JSON.stringify(s, null, 2));
      console.log('---');
    }
    return;
  }

  // Contagem de partidas ÚNICAS com estatística -- a mesma lógica que
  // checar-cobertura-stats.js usa, pra comparar diretamente.
  const { data: todasStatsSerieB } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, escanteios')
    .in('partida_id', idsSerieB);

  const partidasUnicasComEscanteios = new Set(
    (todasStatsSerieB || []).filter((s) => s.escanteios !== null).map((s) => s.partida_id)
  );
  console.log(`Partidas ÚNICAS da Série B com escanteios preenchido: ${partidasUnicasComEscanteios.size}`);
  console.log(`Total de LINHAS (não únicas) de estatística da Série B: ${(todasStatsSerieB || []).length}\n`);

  // Pega as últimas 10 linhas de estatisticas_partida que pertencem à Série B
  const { data: statsSerieB } = await supabase
    .from('estatisticas_partida')
    .select('*')
    .in('partida_id', idsSerieB)
    .order('id', { ascending: false })
    .limit(10);

  console.log(`Mostrando as últimas 10 linhas (por id) de estatística da Série B:\n`);

  for (const s of statsSerieB) {
    console.log(JSON.stringify(s, null, 2));
    console.log('---');
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
