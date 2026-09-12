/**
 * explicar-sinal.js
 *
 * Mostra o raciocínio COMPLETO por trás de qualquer sinal gerado -- pra um
 * jogo específico, refaz o cálculo de todos os mercados (vitória do
 * mandante, gols, dupla hipótese) e mostra os números que levaram a cada
 * probabilidade, exatamente como o gerar-sinais.js calculou.
 *
 * Uso:
 *   node scripts/explicar-sinal.js --busca="Mainz"
 *   node scripts/explicar-sinal.js --busca="Mainz,Frankfurt"
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MINIMO_JOGOS = 3;
const JANELA_GOLS = 10;
const JANELA_POISSON = 25;
const MEIA_VIDA_POISSON = 60;
const MAX_GOLS_POISSON = 8;
const RHO_DIXON_COLES = -0.13;
const LIMIAR_1X = 0.65;
const JANELA_QUESITOS = 6;
const MINIMO_JOGOS_RANKING_QUESITOS = 3;

const QUESITOS = [
  { chave: 'posse_bola', fonte: 'stats', inverter: false, peso: 0.186, nome: 'Posse de bola' },
  { chave: 'finalizacoes', fonte: 'stats', inverter: false, peso: 0.180, nome: 'Finalizações' },
  { chave: 'finalizacoes_no_gol', fonte: 'stats', inverter: false, peso: 0.188, nome: 'Finalizações no gol' },
  { chave: 'escanteios', fonte: 'stats', inverter: false, peso: 0.123, nome: 'Escanteios' },
  { chave: 'gols_pro', fonte: 'partidas', inverter: false, peso: 0.129, nome: 'Gols pró' },
  { chave: 'vitorias', fonte: 'partidas', inverter: false, peso: 0.202, nome: 'Vitórias' },
  { chave: 'gols_contra', fonte: 'partidas', inverter: true, peso: 0.107, nome: 'Gols contra (invertido)' },
  { chave: 'derrotas', fonte: 'partidas', inverter: true, peso: 0.067, nome: 'Derrotas (invertido)' },
];
const SOMA_PESOS_QUESITOS = QUESITOS.reduce((s, q) => s + q.peso, 0);

// ---------- Funções auxiliares (mesma lógica do gerar-sinais.js) ----------

function calcularFatorCombinado(partidasAnteriores, timeCasaId, timeForaId) {
  const jogosCasaTimeCasa = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId);
  if (jogosCasaTimeCasa.length < MINIMO_JOGOS) return null;
  const mediaGolsFeitosCasa = jogosCasaTimeCasa.reduce((s, p) => s + p.gols_casa, 0) / jogosCasaTimeCasa.length;

  const jogosForaTimeFora = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId);
  if (jogosForaTimeFora.length < MINIMO_JOGOS) return null;
  const mediaGolsSofridosFora = jogosForaTimeFora.reduce((s, p) => s + p.gols_casa, 0) / jogosForaTimeFora.length;

  if (partidasAnteriores.length < 10) return null;
  const mediaLigaGolsCasa = partidasAnteriores.reduce((s, p) => s + p.gols_casa, 0) / partidasAnteriores.length;

  return {
    fator: (mediaGolsFeitosCasa - mediaLigaGolsCasa) + (mediaGolsSofridosFora - mediaLigaGolsCasa),
    mediaGolsFeitosCasa, mediaGolsSofridosFora, mediaLigaGolsCasa,
    jogosUsadosCasa: jogosCasaTimeCasa.length, jogosUsadosFora: jogosForaTimeFora.length,
  };
}

function calcularDiffPercentualGols(partidasAnteriores, timeCasaId, timeForaId) {
  const jogosMandante = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId).slice(-JANELA_GOLS);
  if (jogosMandante.length < 3) return null;
  const mediaMandante = jogosMandante.reduce((s, p) => s + p.gols_casa, 0) / jogosMandante.length;

  const jogosVisitante = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId).slice(-JANELA_GOLS);
  if (jogosVisitante.length < 3) return null;
  const mediaVisitante = jogosVisitante.reduce((s, p) => s + p.gols_fora, 0) / jogosVisitante.length;

  if (partidasAnteriores.length < 10) return null;
  const mediaLiga = (partidasAnteriores.reduce((s, p) => s + p.gols_casa + p.gols_fora, 0) / partidasAnteriores.length) / 2;
  const mediaConfronto = (mediaMandante + mediaVisitante) / 2;

  return {
    diffPercentual: ((mediaConfronto - mediaLiga) / mediaLiga) * 100,
    mediaMandante, mediaVisitante, mediaLiga, mediaConfronto,
  };
}

function fatorialPoisson(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poisson(k, lambda) { return (Math.exp(-lambda) * Math.pow(lambda, k)) / fatorialPoisson(k); }
function pesoDecaimentoPoisson(dias) { return Math.pow(0.5, dias / MEIA_VIDA_POISSON); }

function ajusteDixonColes(gc, gf, lc, lf, rho) {
  if (gc === 0 && gf === 0) return 1 - lc * lf * rho;
  if (gc === 0 && gf === 1) return 1 + lc * rho;
  if (gc === 1 && gf === 0) return 1 + lf * rho;
  if (gc === 1 && gf === 1) return 1 - rho;
  return 1;
}

function calcularMediasLigaPoisson(partidas, dataReferencia) {
  let sc = 0, sf = 0, sp = 0;
  for (const p of partidas) {
    const dias = (new Date(dataReferencia) - new Date(p.data_hora)) / 86400000;
    const peso = pesoDecaimentoPoisson(dias);
    sc += p.gols_casa * peso; sf += p.gols_fora * peso; sp += peso;
  }
  if (sp === 0) return { mediaGolsCasa: 1.3, mediaGolsFora: 1.1 };
  return { mediaGolsCasa: sc / sp, mediaGolsFora: sf / sp };
}

function calcularForcaTimePoisson(partidas, timeId, dataReferencia, mgc, mgf) {
  const jc = partidas.filter((p) => p.time_casa_id === timeId).slice(0, JANELA_POISSON);
  const jf = partidas.filter((p) => p.time_fora_id === timeId).slice(0, JANELA_POISSON);
  function media(jogos, pro, contra) {
    let sp2 = 0, sc2 = 0, sw = 0;
    for (const j of jogos) {
      const dias = (new Date(dataReferencia) - new Date(j.data_hora)) / 86400000;
      const peso = pesoDecaimentoPoisson(dias);
      sp2 += j[pro] * peso; sc2 += j[contra] * peso; sw += peso;
    }
    return sw > 0 ? { mediaPro: sp2 / sw, mediaContra: sc2 / sw } : null;
  }
  const emCasa = media(jc, 'gols_casa', 'gols_fora');
  const fora = media(jf, 'gols_fora', 'gols_casa');
  return {
    totalJogos: jc.length + jf.length,
    ataqueCasa: emCasa ? emCasa.mediaPro / mgc : 1,
    defesaCasa: emCasa ? emCasa.mediaContra / mgf : 1,
    ataqueFora: fora ? fora.mediaPro / mgf : 1,
    defesaFora: fora ? fora.mediaContra / mgc : 1,
  };
}

function preverProbabilidadesPoisson(gec, gef) {
  const matriz = [];
  let soma = 0;
  for (let gc = 0; gc <= MAX_GOLS_POISSON; gc++) {
    matriz[gc] = [];
    for (let gf = 0; gf <= MAX_GOLS_POISSON; gf++) {
      const base = poisson(gc, gec) * poisson(gf, gef);
      const ajuste = ajusteDixonColes(gc, gf, gec, gef, RHO_DIXON_COLES);
      matriz[gc][gf] = base * ajuste;
      soma += matriz[gc][gf];
    }
  }
  for (let gc = 0; gc <= MAX_GOLS_POISSON; gc++) for (let gf = 0; gf <= MAX_GOLS_POISSON; gf++) matriz[gc][gf] /= soma;
  let pCasa = 0, pEmpate = 0, pFora = 0;
  for (let gc = 0; gc <= MAX_GOLS_POISSON; gc++) {
    for (let gf = 0; gf <= MAX_GOLS_POISSON; gf++) {
      const p = matriz[gc][gf];
      if (gc > gf) pCasa += p; else if (gc === gf) pEmpate += p; else pFora += p;
    }
  }
  return { pCasa, pEmpate, pFora };
}

function extrairValorPartidasQuesito(partida, timeId, chave) {
  const jogouEmCasa = partida.time_casa_id === timeId;
  const golsPro = jogouEmCasa ? partida.gols_casa : partida.gols_fora;
  const golsContra = jogouEmCasa ? partida.gols_fora : partida.gols_casa;
  if (chave === 'gols_pro') return golsPro;
  if (chave === 'gols_contra') return golsContra;
  if (chave === 'vitorias') return golsPro > golsContra ? 1 : 0;
  if (chave === 'derrotas') return golsPro < golsContra ? 1 : 0;
  return 0;
}

function montarRankingQuesito(historicoCompleto, historicoStats, quesito, statsPorPartidaTime, timesElegiveis) {
  const fonteHistorico = quesito.fonte === 'stats' ? historicoStats : historicoCompleto;
  const valoresPorTime = [];
  for (const timeId of timesElegiveis) {
    const jogosDoTime = fonteHistorico.filter((p) => p.time_casa_id === timeId || p.time_fora_id === timeId).slice(-JANELA_QUESITOS);
    if (jogosDoTime.length < MINIMO_JOGOS_RANKING_QUESITOS) continue;
    let soma = 0;
    for (const p of jogosDoTime) {
      if (quesito.fonte === 'stats') {
        const st = statsPorPartidaTime[`${p.id}_${timeId}`];
        soma += st?.[quesito.chave] ?? 0;
      } else {
        soma += extrairValorPartidasQuesito(p, timeId, quesito.chave);
      }
    }
    valoresPorTime.push({ timeId, valor: soma / jogosDoTime.length });
  }
  valoresPorTime.sort((a, b) => (quesito.inverter ? a.valor - b.valor : b.valor - a.valor));
  const percentis = new Map();
  const total = valoresPorTime.length;
  valoresPorTime.forEach((item, idx) => percentis.set(item.timeId, total > 1 ? 1 - idx / (total - 1) : 0.5));
  return { percentis, total };
}

// ---------- Fluxo principal ----------

async function main() {
  const args = process.argv.slice(2);
  const buscaArg = args.find((a) => a.startsWith('--busca='));
  if (!buscaArg) { console.error('Uso: node scripts/explicar-sinal.js --busca="Mainz,Frankfurt"'); return; }
  const termos = buscaArg.split('=')[1].split(',').map((t) => t.trim().toLowerCase());

  // Localiza o time (ou times) pelo nome
  const { data: todosOsTimes } = await supabase.from('times').select('id, nome');
  const timesEncontrados = todosOsTimes.filter((t) => termos.some((termo) => t.nome.toLowerCase().includes(termo)));

  if (timesEncontrados.length === 0) { console.log('Nenhum time encontrado com esse nome.'); return; }
  console.log('Times encontrados:', timesEncontrados.map((t) => `${t.nome} (id ${t.id})`).join(', '), '\n');

  const idsTimesEncontrados = timesEncontrados.map((t) => t.id);

  // Localiza a partida (jogo futuro, envolvendo pelo menos um desses times)
  const { data: partidasCandidatas } = await supabase
    .from('partidas')
    .select('id, data_hora, competicao_id, time_casa_id, time_fora_id')
    .or(`time_casa_id.in.(${idsTimesEncontrados.join(',')}),time_fora_id.in.(${idsTimesEncontrados.join(',')})`)
    .gte('data_hora', new Date(Date.now() - 6 * 3600000).toISOString()) // até 6h atrás, pra cobrir jogo "de hoje" perto da hora
    .order('data_hora', { ascending: true })
    .limit(5);

  if (!partidasCandidatas || partidasCandidatas.length === 0) { console.log('Nenhuma partida futura encontrada com esse time.'); return; }

  const partida = partidasCandidatas[0];
  const { data: comp } = await supabase.from('competicoes').select('id, nome').eq('id', partida.competicao_id).single();
  const nomeCasa = todosOsTimes.find((t) => t.id === partida.time_casa_id)?.nome || `Time ${partida.time_casa_id}`;
  const nomeFora = todosOsTimes.find((t) => t.id === partida.time_fora_id)?.nome || `Time ${partida.time_fora_id}`;

  console.log(`=== ${comp.nome}: ${nomeCasa} x ${nomeFora} (${new Date(partida.data_hora).toLocaleString('pt-BR')}) ===\n`);

  // Sinais realmente gravados pra esse jogo
  const { data: sinaisGravados } = await supabase.from('sinais').select('*').eq('partida_id', partida.id);
  console.log(`Sinais gravados no banco pra esse jogo: ${sinaisGravados.length}`);
  for (const s of sinaisGravados) console.log(`  - ${s.tipo_mercado}: ${(s.probabilidade_modelo * 100).toFixed(1)}%`);
  console.log('');

  // Recarrega o histórico ANTERIOR a esse jogo (mesma janela que o sistema usou)
  const { data: historicoCompleto } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', partida.competicao_id).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .lt('data_hora', partida.data_hora)
    .order('data_hora', { ascending: true });

  const idsHist = historicoCompleto.map((p) => p.id);
  const { data: statsRaw } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, time_id, posse_bola, finalizacoes, finalizacoes_no_gol, escanteios')
    .in('partida_id', idsHist);
  const statsPorPartidaTime = {};
  for (const s of statsRaw || []) statsPorPartidaTime[`${s.partida_id}_${s.time_id}`] = s;

  const historicoComStats = historicoCompleto.filter((p) => {
    const sc = statsPorPartidaTime[`${p.id}_${p.time_casa_id}`];
    const sf = statsPorPartidaTime[`${p.id}_${p.time_fora_id}`];
    return sc && sf && sc.finalizacoes_no_gol != null && sf.finalizacoes_no_gol != null;
  });

  const todosOsTimesComp = [...new Set(historicoCompleto.flatMap((p) => [p.time_casa_id, p.time_fora_id]))];

  // ---------- 1. Vitória do mandante (consenso) ----------
  console.log('--- 1. Vitória do mandante (consenso: fator combinado + força ponderada) ---\n');

  const fatorResultado = calcularFatorCombinado(historicoCompleto, partida.time_casa_id, partida.time_fora_id);
  if (fatorResultado) {
    console.log(`Fator combinado:`);
    console.log(`  Média de gols feitos por ${nomeCasa} jogando em casa: ${fatorResultado.mediaGolsFeitosCasa.toFixed(2)} (${fatorResultado.jogosUsadosCasa} jogos)`);
    console.log(`  Média de gols sofridos por ${nomeFora} jogando fora: ${fatorResultado.mediaGolsSofridosFora.toFixed(2)} (${fatorResultado.jogosUsadosFora} jogos)`);
    console.log(`  Média de gols em casa da liga inteira: ${fatorResultado.mediaLigaGolsCasa.toFixed(2)}`);
    console.log(`  Fator = (${fatorResultado.mediaGolsFeitosCasa.toFixed(2)} - ${fatorResultado.mediaLigaGolsCasa.toFixed(2)}) + (${fatorResultado.mediaGolsSofridosFora.toFixed(2)} - ${fatorResultado.mediaLigaGolsCasa.toFixed(2)}) = ${fatorResultado.fator.toFixed(3)}`);
    console.log(`  ${fatorResultado.fator > 0 ? '✅ POSITIVO' : '❌ negativo ou zero'} (precisa ser > 0 pra contar como sinal)\n`);
  } else {
    console.log('  Não foi possível calcular (histórico insuficiente)\n');
  }

  let indiceForca = null;
  const detalhesQuesitos = [];
  let todosCalculaveis = true;
  for (const quesito of QUESITOS) {
    const { percentis, total } = montarRankingQuesito(historicoCompleto, historicoComStats, quesito, statsPorPartidaTime, todosOsTimesComp);
    const pCasa = percentis.get(partida.time_casa_id);
    const pFora = percentis.get(partida.time_fora_id);
    if (pCasa === undefined || pFora === undefined) { todosCalculaveis = false; break; }
    detalhesQuesitos.push({ nome: quesito.nome, peso: quesito.peso, pCasa, pFora, diff: pCasa - pFora, total });
  }

  if (todosCalculaveis) {
    indiceForca = detalhesQuesitos.reduce((s, d) => s + (d.peso / SOMA_PESOS_QUESITOS) * d.diff, 0);
    console.log(`Força ponderada (8 quesitos, ranking dentro da liga):`);
    for (const d of detalhesQuesitos) {
      console.log(`  ${d.nome} (peso ${(d.peso / SOMA_PESOS_QUESITOS * 100).toFixed(1)}%): ${nomeCasa} no percentil ${d.pCasa.toFixed(2)}, ${nomeFora} no percentil ${d.pFora.toFixed(2)} (de ${d.total} times) → diferença ${d.diff >= 0 ? '+' : ''}${d.diff.toFixed(2)}`);
    }
    console.log(`  Índice combinado (soma ponderada): ${indiceForca.toFixed(3)}`);
    console.log(`  ${indiceForca > 0 ? '✅ POSITIVO' : '❌ negativo ou zero'} (precisa ser > 0 pra contar como sinal)\n`);
  } else {
    console.log(`Força ponderada: não foi possível calcular (falta dado de posse/finalizações/escanteios pra um dos times -- comum em ligas com pouca cobertura de stats ainda)\n`);
  }

  const consensoAtivo = fatorResultado && fatorResultado.fator > 0 && indiceForca !== null && indiceForca > 0;
  console.log(`>>> Consenso (os 2 positivos ao mesmo tempo): ${consensoAtivo ? '✅ SIM -- gera sinal de vitória do mandante' : '❌ NÃO -- não gera esse sinal'}\n`);

  // ---------- 2. Gols ----------
  console.log('--- 2. Gols (regra percentual) ---\n');
  const golsResultado = calcularDiffPercentualGols(historicoCompleto, partida.time_casa_id, partida.time_fora_id);
  if (golsResultado) {
    console.log(`  Média do ${nomeCasa} como mandante: ${golsResultado.mediaMandante.toFixed(2)} gols`);
    console.log(`  Média do ${nomeFora} como visitante: ${golsResultado.mediaVisitante.toFixed(2)} gols`);
    console.log(`  Média da liga (por time): ${golsResultado.mediaLiga.toFixed(2)}`);
    console.log(`  Diferença percentual: ${golsResultado.diffPercentual.toFixed(1)}%`);
    const faixa = golsResultado.diffPercentual > 30 ? '3+' : golsResultado.diffPercentual > 10 ? '2+' : golsResultado.diffPercentual >= -10 ? '1+' : 'nenhuma (abaixo de -10%)';
    console.log(`  >>> Faixa: ${faixa}\n`);
  } else {
    console.log('  Não foi possível calcular (histórico insuficiente)\n');
  }

  // ---------- 3. Dupla hipótese (Poisson) ----------
  console.log('--- 3. Dupla hipótese (modelo de Poisson + Dixon-Coles) ---\n');
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLigaPoisson(historicoCompleto, partida.data_hora);
  const fc = calcularForcaTimePoisson(historicoCompleto, partida.time_casa_id, partida.data_hora, mediaGolsCasa, mediaGolsFora);
  const ff = calcularForcaTimePoisson(historicoCompleto, partida.time_fora_id, partida.data_hora, mediaGolsCasa, mediaGolsFora);

  if (fc.totalJogos >= 6 && ff.totalJogos >= 6) {
    const gec = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora;
    const gef = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;
    const { pCasa, pEmpate, pFora } = preverProbabilidadesPoisson(gec, gef);
    const p1X = pCasa + pEmpate, pX2 = pEmpate + pFora, p12 = pCasa + pFora;

    console.log(`  Gols esperados: ${nomeCasa} ${gec.toFixed(2)} x ${gef.toFixed(2)} ${nomeFora}`);
    console.log(`  Probabilidades -- Casa: ${(pCasa * 100).toFixed(1)}% | Empate: ${(pEmpate * 100).toFixed(1)}% | Fora: ${(pFora * 100).toFixed(1)}%`);
    console.log(`  Duplas -- 1X: ${(p1X * 100).toFixed(1)}% | X2: ${(pX2 * 100).toFixed(1)}% | 12: ${(p12 * 100).toFixed(1)}%`);
    console.log(`  >>> X2 vira sinal se for a maior das 3: ${pX2 > p1X && pX2 > p12 ? '✅ SIM' : '❌ não'}`);
    console.log(`  >>> 1X vira sinal se passar de ${(LIMIAR_1X * 100).toFixed(0)}%: ${p1X > LIMIAR_1X ? '✅ SIM' : '❌ não'}\n`);
  } else {
    console.log(`  Não foi possível calcular (histórico insuficiente: ${nomeCasa} tem ${fc.totalJogos} jogos, ${nomeFora} tem ${ff.totalJogos}, precisa de pelo menos 6 cada)\n`);
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
