/**
 * verificar-sinais.js
 *
 * Confere os sinais já gerados (tabela `sinais`) contra o resultado REAL dos
 * jogos que já terminaram, grava o resultado em `sinais_resultado`, e mostra
 * um relatório da taxa de acerto ao vivo -- por mercado.
 *
 * Isso é diferente do backtest (que testa contra jogos antigos pra validar o
 * modelo) -- aqui é o acompanhamento contínuo de sinais reais, gerados pelo
 * sistema em produção, conferidos contra o que realmente aconteceu.
 *
 * Uso:
 *   node scripts/verificar-sinais.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltam variáveis de ambiente: SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Decide se um sinal foi correto, comparando o tipo de mercado com o
 * resultado real da partida.
 */
function avaliarSinal(tipoMercado, golsCasa, golsFora) {
  const golsTotais = golsCasa + golsFora;

  if (tipoMercado === 'vitoria_casa') return golsCasa > golsFora;
  if (tipoMercado === 'dupla_x2') return golsCasa <= golsFora;
  if (tipoMercado === 'dupla_1x') return golsCasa >= golsFora;
  if (tipoMercado === 'gols_1mais') return golsTotais >= 1;
  if (tipoMercado === 'gols_2mais') return golsTotais >= 2;
  if (tipoMercado === 'gols_3mais') return golsTotais >= 3;

  return null; // mercado desconhecido -- não avalia
}

async function main() {
  console.log('Buscando sinais gerados que ainda não foram conferidos...\n');

  // Sinais já gerados
  const { data: sinais, error: errSinais } = await supabase
    .from('sinais')
    .select('id, partida_id, tipo_mercado, probabilidade_modelo, nivel_confianca');
  if (errSinais) throw errSinais;

  if (!sinais || sinais.length === 0) {
    console.log('Nenhum sinal gerado ainda -- normal se você ainda não rodou "node scripts/gerar-sinais.js --gerar" com partidas futuras disponíveis.');
    return;
  }

  // Sinais que já foram conferidos antes (não reconfere de novo)
  const { data: jaConferidos, error: errConf } = await supabase
    .from('sinais_resultado')
    .select('sinal_id');
  if (errConf) console.log('  (Aviso: não consegui checar sinais_resultado -- talvez a tabela tenha colunas diferentes. Seguindo mesmo assim.)');

  const idsJaConferidos = new Set((jaConferidos || []).map((s) => s.sinal_id));
  const sinaisPendentes = sinais.filter((s) => !idsJaConferidos.has(s.id));

  console.log(`Total de sinais gerados: ${sinais.length}`);
  console.log(`Sinais ainda não conferidos: ${sinaisPendentes.length}\n`);

  if (sinaisPendentes.length === 0) {
    console.log('Todos os sinais gerados já foram conferidos. Nada novo pra checar agora.');
  } else {
    // Busca o resultado real das partidas desses sinais
    const idsPartidas = [...new Set(sinaisPendentes.map((s) => s.partida_id))];
    const { data: partidas, error: errPartidas } = await supabase
      .from('partidas')
      .select('id, status, gols_casa, gols_fora')
      .in('id', idsPartidas);
    if (errPartidas) throw errPartidas;

    const partidaPorId = Object.fromEntries((partidas || []).map((p) => [p.id, p]));

    let conferidosAgora = 0;
    let aindaNaoTerminaram = 0;

    for (const sinal of sinaisPendentes) {
      const partida = partidaPorId[sinal.partida_id];
      if (!partida || partida.status !== 'finalizado' || partida.gols_casa === null) {
        aindaNaoTerminaram++;
        continue;
      }

      const acertou = avaliarSinal(sinal.tipo_mercado, partida.gols_casa, partida.gols_fora);
      if (acertou === null) continue;

      const { error: erroInsert } = await supabase.from('sinais_resultado').insert({
        sinal_id: sinal.id,
        acertou,
        verificado_em: new Date().toISOString(),
      });

      if (erroInsert) {
        console.error(`  Erro ao gravar resultado do sinal ${sinal.id}:`, erroInsert.message);
        console.error('  (Se o erro for de coluna inexistente, me manda a estrutura real da tabela sinais_resultado que eu ajusto o script.)');
      } else {
        conferidosAgora++;
      }
    }

    console.log(`Conferidos agora: ${conferidosAgora}`);
    console.log(`Ainda aguardando o jogo terminar: ${aindaNaoTerminaram}\n`);
  }

  // ---------- Relatório de taxa de acerto real, por mercado ----------
  console.log('=== Taxa de acerto REAL dos sinais já conferidos, por mercado ===\n');

  const { data: todosConferidos, error: errTodos } = await supabase
    .from('sinais_resultado')
    .select('sinal_id, acertou');
  if (errTodos) {
    console.log('Não foi possível ler sinais_resultado pra montar o relatório:', errTodos.message);
    return;
  }

  if (!todosConferidos || todosConferidos.length === 0) {
    console.log('Ainda não há sinais conferidos suficientes pra montar um relatório.');
    return;
  }

  const idsSinaisConferidos = todosConferidos.map((r) => r.sinal_id);
  const { data: sinaisComTipo } = await supabase
    .from('sinais')
    .select('id, tipo_mercado')
    .in('id', idsSinaisConferidos);

  const tipoPorSinalId = Object.fromEntries((sinaisComTipo || []).map((s) => [s.id, s.tipo_mercado]));

  const porMercado = {};
  for (const r of todosConferidos) {
    const tipo = tipoPorSinalId[r.sinal_id] || 'desconhecido';
    if (!porMercado[tipo]) porMercado[tipo] = { total: 0, acertos: 0 };
    porMercado[tipo].total++;
    if (r.acertou) porMercado[tipo].acertos++;
  }

  for (const [tipo, dados] of Object.entries(porMercado)) {
    const taxa = (dados.acertos / dados.total) * 100;
    console.log(`  ${tipo}: ${dados.acertos}/${dados.total} (${taxa.toFixed(1)}%)`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
