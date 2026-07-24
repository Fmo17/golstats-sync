/**
 * validar-seletividade-outras.js
 *
 * Aplica o MESMO cálculo de fator combinado + tabela de limiares (sem mudar
 * nada) em outras competições, pra validar se o padrão encontrado na Série A
 * (taxa de vitória da casa sobe conforme o limiar aumenta) se repete.
 *
 * Uso:
 *   node scripts/validar-seletividade-outras.js
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

async function calcularParaCompeticao(apiFootballId) {
  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('api_football_id', apiFootballId).single();
  if (!comp) { console.log(`Competição ${apiFootballId} não encontrada.`); return; }

  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  if (error) throw error;

  const jogos = [];

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

    const diferencaAtaque = mediaGolsFeitosCasa - mediaLigaGolsCasa;
    const diferencaDefesa = mediaGolsSofridosFora - mediaLigaGolsCasa;
    const fatorTotal = diferencaAtaque + diferencaDefesa;

    jogos.push({ fatorTotal, casaVenceu: partida.gols_casa > partida.gols_fora });
  }

  console.log(`\n=== ${comp.nome} (${jogos.length} jogos com dado suficiente) ===`);
  console.log('Limiar | Jogos | Vitórias da casa nesse subconjunto');
  console.log('-------|-------|------------------------------------');

  const limiares = [0, 0.15, 0.3, 0.5, 0.7, 1.0];
  for (const limiar of limiares) {
    const subconjunto = jogos.filter((j) => j.fatorTotal > limiar);
    if (subconjunto.length === 0) {
      console.log(`${limiar.toFixed(2)}   | 0 jogos`);
      continue;
    }
    const vitoriasCasa = subconjunto.filter((j) => j.casaVenceu).length;
    const taxa = (vitoriasCasa / subconjunto.length) * 100;
    console.log(`${limiar.toFixed(2).padEnd(6)} | ${String(subconjunto.length).padEnd(5)} | ${vitoriasCasa}/${subconjunto.length} (${taxa.toFixed(1)}%)`);
  }
}

async function main() {
  console.log('Validando o padrão de seletividade (fator combinado) em outras competições...');
  console.log('(Mesmo cálculo da Série A, sem nenhum ajuste -- só aplicando em dado novo.)');

  for (const apiFootballId of [72, 75, 76]) { // Série B, Série C, Série D
    await calcularParaCompeticao(apiFootballId);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
