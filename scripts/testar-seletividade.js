/**
 * testar-seletividade.js
 *
 * Testa se FILTRAR só os jogos com "fator combinado" acima de um certo
 * limiar aumenta a taxa de acerto -- e faz a comparação corretamente: a
 * linha de base usada é a taxa de vitória do mandante DENTRO DESSE MESMO
 * SUBCONJUNTO filtrado, não do campeonato inteiro (senão a comparação fica
 * injusta, porque filtrar por fator alto já favorece naturalmente jogos
 * onde o mandante tende mais a vencer).
 *
 * Uso:
 *   node scripts/testar-seletividade.js --competicao=71
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
const MINIMO_JOGOS = 3;

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));
  const apiFootballId = competicaoArg ? parseInt(competicaoArg.split('=')[1], 10) : 71;

  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.error('Competição não encontrada.'); return; }

  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  if (error) throw error;

  console.log(`${comp.nome} -- calculando fator combinado pra cada jogo...\n`);

  const jogos = []; // vai guardar { fatorTotal, casaVenceu }

  for (let i = 0; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    const jogosCasaTimeCasa = anteriores.filter((p) => p.time_casa_id === partida.time_casa_id);
    if (jogosCasaTimeCasa.length < MINIMO_JOGOS) continue;
    const mediaGolsFeitosCasa = jogosCasaTimeCasa.reduce((s, p) => s + p.gols_casa, 0) / jogosCasaTimeCasa.length;

    const jogosForaTimeFora = anteriores.filter((p) => p.time_fora_id === partida.time_fora_id);
    if (jogosForaTimeFora.length < MINIMO_JOGOS) continue;
    const mediaGolsSofridosFora = jogosForaTimeFora.reduce((s, p) => s + p.gols_casa, 0) / jogosForaTimeFora.length;

    if (anteriores.length < 10) continue;
    const mediaLigaGolsCasa = anteriores.reduce((s, p) => s + p.gols_casa, 0) / anteriores.length;
    const mediaLigaSofridoFora = mediaLigaGolsCasa; // mesma conta, gols sofridos por quem joga fora = gols_casa da partida

    const diferencaAtaque = mediaGolsFeitosCasa - mediaLigaGolsCasa;
    const diferencaDefesa = mediaGolsSofridosFora - mediaLigaSofridoFora;
    const fatorTotal = diferencaAtaque + diferencaDefesa;

    jogos.push({
      fatorTotal,
      casaVenceu: partida.gols_casa > partida.gols_fora,
    });
  }

  console.log(`Total de jogos com dado suficiente: ${jogos.length}\n`);

  const limiares = [0, 0.15, 0.3, 0.5, 0.7, 1.0, 1.3, 1.5, 2.0];

  console.log('Limiar | Jogos no subconjunto | Vitórias reais da casa nesse subconjunto | "Taxa de acerto" prevendo sempre casa nesse subconjunto');
  console.log('-------|----------------------|------------------------------------------|--------------------------------------------------------');

  for (const limiar of limiares) {
    const subconjunto = jogos.filter((j) => j.fatorTotal > limiar);
    if (subconjunto.length === 0) {
      console.log(`${limiar.toFixed(2)}   | 0 jogos -- ninguém passou desse limiar`);
      continue;
    }
    const vitoriasCasa = subconjunto.filter((j) => j.casaVenceu).length;
    const taxaVitoriaCasa = (vitoriasCasa / subconjunto.length) * 100;

    console.log(`${limiar.toFixed(2).padEnd(6)} | ${String(subconjunto.length).padEnd(20)} | ${vitoriasCasa}/${subconjunto.length} (${taxaVitoriaCasa.toFixed(1)}%)`);
  }

  console.log('\n=== Como interpretar ===');
  console.log('Se a "taxa de vitória da casa" SOBE conforme o limiar aumenta, isso confirma que o fator');
  console.log('combinado realmente identifica jogos mais favoráveis ao mandante -- ou seja, filtrar por');
  console.log('fator alto aumenta a confiança real, não só filtra jogos aleatórios.');
  console.log('\nSe a taxa ficar estável ou não crescer de forma clara, o fator não está discriminando bem.');
  console.log('\nATENÇÃO: com poucos jogos no subconjunto (ex: menos de 30-40), o número fica pouco confiável');
  console.log('(pode ser sorte da amostra pequena, não um padrão real).');
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
