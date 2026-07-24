/**
 * correlacao-gols.js
 *
 * Calcula a correlação estatística (coeficiente de Pearson) entre:
 *  - gols feitos pelo time da casa (histórico, em jogos em casa)
 *  - gols sofridos pelo time visitante (histórico, em jogos fora de casa)
 *
 * O coeficiente de Pearson (r) varia de -1 a +1:
 *   r perto de +1  → quando um valor é alto, o outro tende a ser alto também
 *   r perto de  0  → não há relação linear entre as duas variáveis
 *   r perto de -1  → quando um é alto, o outro tende a ser baixo
 *
 * Também mostra a correlação de cada variável com o gol REAL que aconteceu
 * na partida -- isso é o que valida (ou não) o pressuposto usado no modelo
 * de Poisson, que combina essas duas informações pra estimar gols esperados.
 *
 * Uso:
 *   node scripts/correlacao-gols.js --competicao=71
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
const JANELA = 10; // quantos jogos anteriores (em casa/fora) entram na média de cada time

function correlacaoPearson(X, Y) {
  const n = X.length;
  const mediaX = X.reduce((a, b) => a + b, 0) / n;
  const mediaY = Y.reduce((a, b) => a + b, 0) / n;

  let somaProdutos = 0, somaQuadX = 0, somaQuadY = 0;
  for (let i = 0; i < n; i++) {
    const dx = X[i] - mediaX;
    const dy = Y[i] - mediaY;
    somaProdutos += dx * dy;
    somaQuadX += dx * dx;
    somaQuadY += dy * dy;
  }

  const denominador = Math.sqrt(somaQuadX * somaQuadY);
  return denominador === 0 ? 0 : somaProdutos / denominador;
}

function interpretarR(r) {
  const abs = Math.abs(r);
  if (abs < 0.1) return 'praticamente nenhuma correlação';
  if (abs < 0.3) return 'correlação fraca';
  if (abs < 0.5) return 'correlação moderada';
  if (abs < 0.7) return 'correlação forte';
  return 'correlação muito forte';
}

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) {
    console.error('Competição não encontrada.');
    return;
  }

  console.log(`Carregando partidas de: ${comp.nome}...`);
  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id)
    .eq('status', 'finalizado')
    .not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });

  if (error) throw error;
  console.log(`${todasPartidas.length} partidas carregadas.\n`);

  const inicioValido = Math.floor(todasPartidas.length * 0.2); // pequeno aquecimento, só o suficiente pra ter jogos anteriores
  const X = []; // gols marcados pelo time da casa, média histórica em casa
  const Y = []; // gols sofridos pelo time visitante, média histórica fora
  const Z = []; // gols reais marcados pelo time da casa nessa partida

  for (let i = inicioValido; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    const jogosCasaTimeCasa = anteriores.filter((p) => p.time_casa_id === partida.time_casa_id).slice(-JANELA);
    const jogosForaTimeFora = anteriores.filter((p) => p.time_fora_id === partida.time_fora_id).slice(-JANELA);

    if (jogosCasaTimeCasa.length < 3 || jogosForaTimeFora.length < 3) continue; // pouco histórico, pula

    const mediaGolsFeitosCasa = jogosCasaTimeCasa.reduce((s, j) => s + j.gols_casa, 0) / jogosCasaTimeCasa.length;
    const mediaGolsSofridosFora = jogosForaTimeFora.reduce((s, j) => s + j.gols_casa, 0) / jogosForaTimeFora.length;
    // Nota: em jogos fora, o que o time visitante "sofre" é o gols_casa da partida (gol do adversário, que jogava em casa)

    X.push(mediaGolsFeitosCasa);
    Y.push(mediaGolsSofridosFora);
    Z.push(partida.gols_casa); // gol real que aconteceu nessa partida específica
  }

  console.log(`Partidas usadas na análise (com histórico suficiente): ${X.length}\n`);

  const rXY = correlacaoPearson(X, Y);
  const rXZ = correlacaoPearson(X, Z);
  const rYZ = correlacaoPearson(Y, Z);

  console.log('=== Resultado da correlação ===\n');
  console.log(`Correlação entre "gols feitos em casa" (histórico) e "gols sofridos fora" (histórico do adversário):`);
  console.log(`  r = ${rXY.toFixed(3)}  →  ${interpretarR(rXY)}`);
  console.log(`  Interpretação: times que fazem muitos gols em casa tendem a enfrentar, na amostra, adversários que também sofrem muitos gols fora ${rXY > 0.1 ? '(relação positiva real)' : '(relação fraca ou inexistente)'}.\n`);

  console.log(`Correlação entre "gols feitos em casa" (histórico) e o gol REAL que aconteceu na partida:`);
  console.log(`  r = ${rXZ.toFixed(3)}  →  ${interpretarR(rXZ)}`);
  console.log(`  Interpretação: o histórico de gols em casa do mandante ${rXZ > 0.2 ? 'realmente ajuda a prever' : 'tem pouco poder de prever'} quantos gols ele fará no próximo jogo.\n`);

  console.log(`Correlação entre "gols sofridos fora" do visitante (histórico) e o gol REAL que aconteceu na partida:`);
  console.log(`  r = ${rYZ.toFixed(3)}  →  ${interpretarR(rYZ)}`);
  console.log(`  Interpretação: o histórico de gols sofridos fora do visitante ${rYZ > 0.2 ? 'realmente ajuda a prever' : 'tem pouco poder de prever'} quantos gols o mandante fará contra ele.\n`);

  console.log('=== O que isso significa pro modelo ===');
  console.log('O modelo de Poisson combina X e Y multiplicando as duas "forças" pra estimar o gol esperado.');
  console.log('Se rXZ e rYZ forem bem maiores que zero, isso confirma que essas duas variáveis realmente');
  console.log('carregam informação útil sobre o resultado real -- o que valida (ou não) a lógica do modelo.');
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
