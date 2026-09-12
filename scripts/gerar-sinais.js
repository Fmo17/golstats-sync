/**
 * gerar-sinais.js
 *
 * Pipeline de geração de sinais reais -- conecta os modelos validados com as
 * tabelas `sinais` e `estatisticas_modelo` do schema.
 *
 * Mercados:
 *  - vitoria_casa: CONSENSO (fator combinado + força ponderada, ambos > 0).
 *    Validado como melhor que qualquer um dos dois sozinho em
 *    scripts/teste-consenso.js e scripts/validar-consenso-outras.js.
 *  - gols_1mais / gols_2mais / gols_3mais: regra percentual (mandante como
 *    mandante + visitante como visitante vs. média da liga).
 *  - dupla_x2: Poisson+Dixon-Coles, quando X2 é a dupla mais provável das 3.
 *  - dupla_1x: Poisson+Dixon-Coles, quando prob(1X) > 0.65.
 *
 * Proteção: nenhum resultado com amostra < 60 casos é gravado como
 * estatística pública (evita "100% de acerto" com poucos casos).
 *
 * Uso:
 *   node scripts/gerar-sinais.js --calibrar [--competicao=71]
 *   node scripts/gerar-sinais.js --gerar [--competicao=71]
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
const JANELA_AMOSTRA_PADRAO = 200;

// ---------- Mercado: vitória do mandante -- fator combinado (parte do consenso) ----------

function calcularFatorCombinado(partidasAnteriores, timeCasaId, timeForaId) {
  const jogosCasaTimeCasa = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId);
  if (jogosCasaTimeCasa.length < MINIMO_JOGOS) return null;
  const mediaGolsFeitosCasa = jogosCasaTimeCasa.reduce((s, p) => s + p.gols_casa, 0) / jogosCasaTimeCasa.length;

  const jogosForaTimeFora = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId);
  if (jogosForaTimeFora.length < MINIMO_JOGOS) return null;
  const mediaGolsSofridosFora = jogosForaTimeFora.reduce((s, p) => s + p.gols_casa, 0) / jogosForaTimeFora.length;

  if (partidasAnteriores.length < 10) return null;
  const mediaLigaGolsCasa = partidasAnteriores.reduce((s, p) => s + p.gols_casa, 0) / partidasAnteriores.length;

  const diferencaAtaque = mediaGolsFeitosCasa - mediaLigaGolsCasa;
  const diferencaDefesa = mediaGolsSofridosFora - mediaLigaGolsCasa;
  return diferencaAtaque + diferencaDefesa;
}

// ---------- Mercado: gols (1+, 2+, 3+) -- regra percentual ----------

const JANELA_GOLS = 10;

function calcularDiffPercentualGols(partidasAnteriores, timeCasaId, timeForaId) {
  const jogosMandante = partidasAnteriores.filter((p) => p.time_casa_id === timeCasaId).slice(-JANELA_GOLS);
  if (jogosMandante.length < 3) return null;
  const mediaMandante = jogosMandante.reduce((s, p) => s + p.gols_casa, 0) / jogosMandante.length;

  const jogosVisitante = partidasAnteriores.filter((p) => p.time_fora_id === timeForaId).slice(-JANELA_GOLS);
  if (jogosVisitante.length < 3) return null;
  const mediaVisitante = jogosVisitante.reduce((s, p) => s + p.gols_fora, 0) / jogosVisitante.length;

  if (partidasAnteriores.length < 10) return null;
  const mediaLigaTotal = partidasAnteriores.reduce((s, p) => s + p.gols_casa + p.gols_fora, 0) / partidasAnteriores.length;
  const mediaLiga = mediaLigaTotal / 2;
  const mediaConfronto = (mediaMandante + mediaVisitante) / 2;

  return ((mediaConfronto - mediaLiga) / mediaLiga) * 100;
}

function classificarFaixaGols(diffPercentual) {
  if (diffPercentual > 30) return '3mais';
  if (diffPercentual > 10) return '2mais';
  if (diffPercentual >= -10) return '1mais';
  return null;
}

// ---------- Motor de Poisson + Dixon-Coles (mercados X2 e 1X) ----------

const JANELA_POISSON = 25;
const MEIA_VIDA_POISSON = 60;
const MAX_GOLS_POISSON = 8;
const RHO_DIXON_COLES = -0.13;
const LIMIAR_1X = 0.65;

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

function preverX2(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLigaPoisson(partidasAnteriores, dataReferencia);
  const fc = calcularForcaTimePoisson(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const ff = calcularForcaTimePoisson(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  if (fc.totalJogos < 6 || ff.totalJogos < 6) return null;
  const gec = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora;
  const gef = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;
  const { pCasa, pEmpate, pFora } = preverProbabilidadesPoisson(gec, gef);
  const p1X = pCasa + pEmpate, pX2 = pEmpate + pFora, p12 = pCasa + pFora;
  const duplas = { '1X': p1X, 'X2': pX2, '12': p12 };
  const previstaDupla = Object.entries(duplas).sort((a, b) => b[1] - a[1])[0][0];
  return previstaDupla === 'X2';
}

function preverUm1X(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLigaPoisson(partidasAnteriores, dataReferencia);
  const fc = calcularForcaTimePoisson(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const ff = calcularForcaTimePoisson(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  if (fc.totalJogos < 6 || ff.totalJogos < 6) return null;
  const gec = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora;
  const gef = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;
  const { pCasa, pEmpate } = preverProbabilidadesPoisson(gec, gef);
  return (pCasa + pEmpate) > LIMIAR_1X;
}

// ---------- Força ponderada (8 quesitos, pesos fixos calculados na Série A) ----------

const JANELA_QUESITOS = 6;
const MINIMO_JOGOS_RANKING_QUESITOS = 3;

const QUESITOS = [
  { chave: 'posse_bola', fonte: 'stats', inverter: false, peso: 0.186 },
  { chave: 'finalizacoes', fonte: 'stats', inverter: false, peso: 0.180 },
  { chave: 'finalizacoes_no_gol', fonte: 'stats', inverter: false, peso: 0.188 },
  { chave: 'escanteios', fonte: 'stats', inverter: false, peso: 0.123 },
  { chave: 'gols_pro', fonte: 'partidas', inverter: false, peso: 0.129 },
  { chave: 'vitorias', fonte: 'partidas', inverter: false, peso: 0.202 },
  { chave: 'gols_contra', fonte: 'partidas', inverter: true, peso: 0.107 },
  { chave: 'derrotas', fonte: 'partidas', inverter: true, peso: 0.067 },
];
const SOMA_PESOS_QUESITOS = QUESITOS.reduce((s, q) => s + q.peso, 0);

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
  return percentis;
}

function calcularIndiceForca(historicoCompleto, historicoStats, timeCasaId, timeForaId, statsPorPartidaTime, timesElegiveis) {
  let indice = 0;
  for (const quesito of QUESITOS) {
    const ranking = montarRankingQuesito(historicoCompleto, historicoStats, quesito, statsPorPartidaTime, timesElegiveis);
    const pCasa = ranking.get(timeCasaId);
    const pFora = ranking.get(timeForaId);
    if (pCasa === undefined || pFora === undefined) return null;
    indice += (quesito.peso / SOMA_PESOS_QUESITOS) * (pCasa - pFora);
  }
  return indice;
}

// ---------- Calibração ----------

async function calibrarCompeticao(competicaoId, nomeCompeticao) {
  const { data: todasPartidas, error } = await supabase
    .from('partidas')
    .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
    .eq('competicao_id', competicaoId).eq('status', 'finalizado').not('gols_casa', 'is', null)
    .order('data_hora', { ascending: true });
  if (error) throw error;

  if (!todasPartidas || todasPartidas.length < 40) {
    console.log(`  ${nomeCompeticao}: partidas insuficientes, pulando.`);
    return [];
  }

  const idsPartidas = todasPartidas.map((p) => p.id);
  const { data: statsRaw } = await supabase
    .from('estatisticas_partida')
    .select('partida_id, time_id, posse_bola, finalizacoes, finalizacoes_no_gol, escanteios')
    .in('partida_id', idsPartidas);

  const statsPorPartidaTime = {};
  for (const s of statsRaw || []) statsPorPartidaTime[`${s.partida_id}_${s.time_id}`] = s;

  const todasPartidasComStats = todasPartidas.filter((p) => {
    const sc = statsPorPartidaTime[`${p.id}_${p.time_casa_id}`];
    const sf = statsPorPartidaTime[`${p.id}_${p.time_fora_id}`];
    return sc && sf && sc.finalizacoes_no_gol != null && sf.finalizacoes_no_gol != null;
  });

  const todosOsTimes = [...new Set(todasPartidas.flatMap((p) => [p.time_casa_id, p.time_fora_id]))];

  const casosConsenso = [];
  const porFaixaGols = { '1mais': [], '2mais': [], '3mais': [] };
  const casosX2 = [];
  const casos1X = [];

  for (let i = 0; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);
    const anterioresComStats = todasPartidasComStats.filter((p) => new Date(p.data_hora) < new Date(partida.data_hora));

    const fator = calcularFatorCombinado(anteriores, partida.time_casa_id, partida.time_fora_id);
    const indiceForca = calcularIndiceForca(anteriores, anterioresComStats, partida.time_casa_id, partida.time_fora_id, statsPorPartidaTime, todosOsTimes);
    if (fator !== null && indiceForca !== null && fator > 0 && indiceForca > 0) {
      casosConsenso.push(partida.gols_casa > partida.gols_fora);
    }

    const diffPercentual = calcularDiffPercentualGols(anteriores, partida.time_casa_id, partida.time_fora_id);
    if (diffPercentual !== null) {
      const faixa = classificarFaixaGols(diffPercentual);
      const golsTotais = partida.gols_casa + partida.gols_fora;
      if (faixa === '1mais') porFaixaGols['1mais'].push(golsTotais >= 1);
      if (faixa === '2mais') porFaixaGols['2mais'].push(golsTotais >= 2);
      if (faixa === '3mais') porFaixaGols['3mais'].push(golsTotais >= 3);
    }

    const modeloIndicaX2 = preverX2(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
    if (modeloIndicaX2 === true) {
      casosX2.push(partida.gols_casa <= partida.gols_fora);
    }

    const modeloIndica1X = preverUm1X(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
    if (modeloIndica1X === true) {
      casos1X.push(partida.gols_casa >= partida.gols_fora);
    }
  }

  const resultados = [];
  const MINIMO_AMOSTRA_CONFIAVEL = 60;

  if (casosConsenso.length >= 10) {
    const acertos = casosConsenso.filter((x) => x).length;
    const taxaAcerto = acertos / casosConsenso.length;
    const confiavel = casosConsenso.length >= MINIMO_AMOSTRA_CONFIAVEL;
    resultados.push({ competicaoId, nomeCompeticao, mercado: 'vitoria_casa', nivel: 'padrao', amostra: casosConsenso.length, taxaAcerto, confiavel });
    console.log(`  ${nomeCompeticao} [vitória do mandante, consenso] -- ${casosConsenso.length} casos, taxa de acerto ${(taxaAcerto * 100).toFixed(1)}%${confiavel ? '' : '  ⚠️  AMOSTRA PEQUENA'}`);
  }

  for (const faixa of ['1mais', '2mais', '3mais']) {
    const casos = porFaixaGols[faixa];
    if (casos.length < 10) continue;
    const acertos = casos.filter((x) => x).length;
    const taxaAcerto = acertos / casos.length;
    const confiavel = casos.length >= MINIMO_AMOSTRA_CONFIAVEL;
    resultados.push({ competicaoId, nomeCompeticao, mercado: `gols_${faixa}`, nivel: 'padrao', amostra: casos.length, taxaAcerto, confiavel });
    const rotulo = faixa === '1mais' ? '1+' : faixa === '2mais' ? '2+' : '3+';
    console.log(`  ${nomeCompeticao} [gols ${rotulo}] -- ${casos.length} casos, taxa de acerto ${(taxaAcerto * 100).toFixed(1)}%${confiavel ? '' : '  ⚠️  AMOSTRA PEQUENA'}`);
  }

  if (casosX2.length >= 10) {
    const acertos = casosX2.filter((x) => x).length;
    const taxaAcerto = acertos / casosX2.length;
    const confiavel = casosX2.length >= MINIMO_AMOSTRA_CONFIAVEL;
    resultados.push({ competicaoId, nomeCompeticao, mercado: 'dupla_x2', nivel: 'padrao', amostra: casosX2.length, taxaAcerto, confiavel });
    console.log(`  ${nomeCompeticao} [dupla hipótese X2] -- ${casosX2.length} casos, taxa de acerto ${(taxaAcerto * 100).toFixed(1)}%${confiavel ? '' : '  ⚠️  AMOSTRA PEQUENA'}`);
  }

  if (casos1X.length >= 10) {
    const acertos = casos1X.filter((x) => x).length;
    const taxaAcerto = acertos / casos1X.length;
    const confiavel = casos1X.length >= MINIMO_AMOSTRA_CONFIAVEL;
    resultados.push({ competicaoId, nomeCompeticao, mercado: 'dupla_1x', nivel: 'padrao', amostra: casos1X.length, taxaAcerto, confiavel });
    console.log(`  ${nomeCompeticao} [dupla hipótese 1X] -- ${casos1X.length} casos, taxa de acerto ${(taxaAcerto * 100).toFixed(1)}%${confiavel ? '' : '  ⚠️  AMOSTRA PEQUENA'}`);
  }

  return resultados;
}

async function modoCalibrar(competicaoArg) {
  let query = supabase.from('competicoes').select('id, nome, api_football_id').eq('ativa', true);
  if (competicaoArg) query = query.eq('api_football_id', parseInt(competicaoArg.split('=')[1], 10));

  const { data: competicoes, error } = await query;
  if (error) throw error;

  console.log('Calibrando (mercados: vitória do mandante [consenso] + gols 1+/2+/3+ + dupla hipótese X2/1X)...\n');

  const todosResultados = [];
  for (const comp of competicoes) {
    const resultados = await calibrarCompeticao(comp.id, comp.nome);
    todosResultados.push(...resultados);
  }

  const resultadosConfiaveis = todosResultados.filter((r) => r.confiavel);
  const resultadosDescartados = todosResultados.filter((r) => !r.confiavel);

  if (resultadosDescartados.length > 0) {
    console.log(`\n⚠️  ${resultadosDescartados.length} resultado(s) com amostra pequena demais NÃO serão gravados:`);
    for (const r of resultadosDescartados) {
      console.log(`   - ${r.nomeCompeticao} / ${r.mercado} (${r.amostra} casos)`);
    }
  }

  console.log(`\nGravando ${resultadosConfiaveis.length} registros confiáveis em estatisticas_modelo...`);
  for (const r of resultadosConfiaveis) {
    const { error } = await supabase.from('estatisticas_modelo').insert({
      tipo_mercado: `${r.mercado}_${r.nomeCompeticao.toLowerCase().replace(/\s+/g, '_')}`,
      nivel_confianca: r.nivel,
      janela_amostra: r.amostra,
      taxa_acerto: r.taxaAcerto,
      ev_medio: null,
    });
    if (error) console.error(`  Erro ao gravar (${r.nomeCompeticao}, ${r.mercado}):`, error.message);
  }
  console.log('Calibração concluída.');
}

// ---------- Geração de sinais reais ----------

async function modoGerar(competicaoArg) {
  let query = supabase.from('competicoes').select('id, nome, api_football_id').eq('ativa', true);
  if (competicaoArg) query = query.eq('api_football_id', parseInt(competicaoArg.split('=')[1], 10));

  const { data: competicoes, error } = await query;
  if (error) throw error;

  let totalGerados = 0;
  const JANELA_DIAS_GERACAO = 5; // só gera sinal pra jogos dentro dessa janela -- mantém o dado usado no cálculo mais fresco, e evita sinal "congelado" muito antes do jogo acontecer

  for (const comp of competicoes) {
    const limiteFuturo = new Date(Date.now() + JANELA_DIAS_GERACAO * 86400000).toISOString();

    const { data: partidasAgendadas } = await supabase
      .from('partidas')
      .select('id, data_hora, time_casa_id, time_fora_id')
      .eq('competicao_id', comp.id)
      .eq('status', 'agendado')
      .gte('data_hora', new Date().toISOString()) // nunca gera sinal pra "agendado" do passado (jogo adiado/cancelado que não foi reclassificado)
      .lte('data_hora', limiteFuturo); // só os próximos N dias

    if (!partidasAgendadas || partidasAgendadas.length === 0) continue;

    const { data: historico } = await supabase
      .from('partidas')
      .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
      .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
      .order('data_hora', { ascending: true });

    const idsHistorico = (historico || []).map((p) => p.id);
    const { data: statsRaw } = await supabase
      .from('estatisticas_partida')
      .select('partida_id, time_id, posse_bola, finalizacoes, finalizacoes_no_gol, escanteios')
      .in('partida_id', idsHistorico);
    const statsPorPartidaTime = {};
    for (const s of statsRaw || []) statsPorPartidaTime[`${s.partida_id}_${s.time_id}`] = s;
    const historicoComStats = (historico || []).filter((p) => {
      const sc = statsPorPartidaTime[`${p.id}_${p.time_casa_id}`];
      const sf = statsPorPartidaTime[`${p.id}_${p.time_fora_id}`];
      return sc && sf && sc.finalizacoes_no_gol != null && sf.finalizacoes_no_gol != null;
    });
    const todosOsTimesComp = [...new Set((historico || []).flatMap((p) => [p.time_casa_id, p.time_fora_id]))];

    const { data: timesDaComp } = await supabase.from('times').select('id, nome').in('id', todosOsTimesComp);
    const nomePorTimeId = Object.fromEntries((timesDaComp || []).map((t) => [t.id, t.nome]));

    // Busca os sinais que JÁ EXISTEM pras partidas agendadas dessa competição,
    // pra nunca duplicar -- essencial já que --gerar é rodado repetidamente
    // (todo dia, conforme jogos novos são agendados).
    const idsPartidasAgendadas = partidasAgendadas.map((p) => p.id);
    const { data: sinaisExistentes } = await supabase
      .from('sinais')
      .select('partida_id, tipo_mercado')
      .in('partida_id', idsPartidasAgendadas);

    const jaTemSinal = new Set((sinaisExistentes || []).map((s) => `${s.partida_id}_${s.tipo_mercado}`));

    for (const partida of partidasAgendadas) {
      const historicoAntes = (historico || []).filter((p) => new Date(p.data_hora) < new Date(partida.data_hora));
      const historicoComStatsAntes = historicoComStats.filter((p) => new Date(p.data_hora) < new Date(partida.data_hora));

      // Mercado: vitória do mandante (consenso)
      const fator = calcularFatorCombinado(historicoAntes, partida.time_casa_id, partida.time_fora_id);
      const indiceForca = calcularIndiceForca(historicoAntes, historicoComStatsAntes, partida.time_casa_id, partida.time_fora_id, statsPorPartidaTime, todosOsTimesComp);

      if (fator !== null && indiceForca !== null && fator > 0 && indiceForca > 0 && !jaTemSinal.has(`${partida.id}_vitoria_casa`)) {
        const { data: calibracao } = await supabase
          .from('estatisticas_modelo')
          .select('taxa_acerto')
          .eq('tipo_mercado', `vitoria_casa_${comp.nome.toLowerCase().replace(/\s+/g, '_')}`)
          .eq('nivel_confianca', 'padrao')
          .order('calculado_em', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (calibracao?.taxa_acerto != null) {
          const nomeCasaTxt = nomePorTimeId[partida.time_casa_id] || 'o mandante';
          const nomeForaTxt = nomePorTimeId[partida.time_fora_id] || 'o visitante';
          const { error: erroInsert } = await supabase.from('sinais').insert({
            partida_id: partida.id,
            tipo_mercado: 'vitoria_casa',
            probabilidade_modelo: calibracao.taxa_acerto,
            nivel_confianca: 'padrao',
            pacote_minimo: 'basico',
            explicacao: `O ${nomeCasaTxt} teve desempenho ofensivo em casa acima da média da liga, e o ${nomeForaTxt} teve desempenho defensivo fora abaixo da média. Além disso, olhando um conjunto de 8 indicadores de forma recente (posse de bola, finalizações, escanteios, aproveitamento e mais), o ${nomeCasaTxt} também está melhor posicionado. Os 2 sinais concordam, o que aumenta a confiança do modelo.`,
          });
          if (erroInsert) console.error('Erro ao gravar sinal (vitória casa):', erroInsert.message);
          else totalGerados++;
        }
      }

      // Mercado: gols (1+, 2+, 3+)
      const diffPercentual = calcularDiffPercentualGols(historicoAntes, partida.time_casa_id, partida.time_fora_id);
      if (diffPercentual !== null) {
        const faixa = classificarFaixaGols(diffPercentual);
        if (faixa && !jaTemSinal.has(`${partida.id}_gols_${faixa}`)) {
          const { data: calibracaoGols } = await supabase
            .from('estatisticas_modelo')
            .select('taxa_acerto')
            .eq('tipo_mercado', `gols_${faixa}_${comp.nome.toLowerCase().replace(/\s+/g, '_')}`)
            .eq('nivel_confianca', 'padrao')
            .order('calculado_em', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (calibracaoGols?.taxa_acerto != null) {
            const nomeCasaTxt = nomePorTimeId[partida.time_casa_id] || 'o mandante';
            const nomeForaTxt = nomePorTimeId[partida.time_fora_id] || 'o visitante';
            const rotuloFaixa = faixa === '1mais' ? 'pelo menos 1 gol' : faixa === '2mais' ? 'pelo menos 2 gols' : 'pelo menos 3 gols';
            const { error: erroInsertGols } = await supabase.from('sinais').insert({
              partida_id: partida.id,
              tipo_mercado: `gols_${faixa}`,
              probabilidade_modelo: calibracaoGols.taxa_acerto,
              nivel_confianca: 'padrao',
              pacote_minimo: 'basico',
              explicacao: `A média de gols do ${nomeCasaTxt} jogando em casa e do ${nomeForaTxt} jogando fora, comparada com a média geral da competição, indica uma tendência de jogo com ${rotuloFaixa}.`,
            });
            if (erroInsertGols) console.error('Erro ao gravar sinal (gols):', erroInsertGols.message);
            else totalGerados++;
          }
        }
      }

      // Mercado: dupla hipótese X2
      const modeloIndicaX2 = preverX2(historicoAntes, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
      if (modeloIndicaX2 === true && !jaTemSinal.has(`${partida.id}_dupla_x2`)) {
        const { data: calibracaoX2 } = await supabase
          .from('estatisticas_modelo')
          .select('taxa_acerto')
          .eq('tipo_mercado', `dupla_x2_${comp.nome.toLowerCase().replace(/\s+/g, '_')}`)
          .eq('nivel_confianca', 'padrao')
          .order('calculado_em', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (calibracaoX2?.taxa_acerto != null) {
          const nomeForaTxt = nomePorTimeId[partida.time_fora_id] || 'o visitante';
          const { error: erroInsertX2 } = await supabase.from('sinais').insert({
            partida_id: partida.id,
            tipo_mercado: 'dupla_x2',
            probabilidade_modelo: calibracaoX2.taxa_acerto,
            nivel_confianca: 'padrao',
            pacote_minimo: 'basico',
            explicacao: `O modelo estatístico calcula a chance de vitória do mandante, empate e vitória do visitante a partir do desempenho recente dos 2 times. Nesse jogo, a combinação "empate ou vitória do ${nomeForaTxt}" ficou mais provável que as outras 2 combinações possíveis.`,
          });
          if (erroInsertX2) console.error('Erro ao gravar sinal (X2):', erroInsertX2.message);
          else totalGerados++;
        }
      }

      // Mercado: dupla hipótese 1X
      const modeloIndica1X = preverUm1X(historicoAntes, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
      if (modeloIndica1X === true && !jaTemSinal.has(`${partida.id}_dupla_1x`)) {
        const { data: calibracao1X } = await supabase
          .from('estatisticas_modelo')
          .select('taxa_acerto')
          .eq('tipo_mercado', `dupla_1x_${comp.nome.toLowerCase().replace(/\s+/g, '_')}`)
          .eq('nivel_confianca', 'padrao')
          .order('calculado_em', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (calibracao1X?.taxa_acerto != null) {
          const nomeCasaTxt = nomePorTimeId[partida.time_casa_id] || 'o mandante';
          const { error: erroInsert1X } = await supabase.from('sinais').insert({
            partida_id: partida.id,
            tipo_mercado: 'dupla_1x',
            probabilidade_modelo: calibracao1X.taxa_acerto,
            nivel_confianca: 'padrao',
            pacote_minimo: 'basico',
            explicacao: `O modelo estatístico calcula a chance de vitória do mandante, empate e vitória do visitante a partir do desempenho recente dos 2 times. Nesse jogo, a combinação "vitória do ${nomeCasaTxt} ou empate" passou do limiar de confiança que historicamente se mostrou consistente nessa competição.`,
          });
          if (erroInsert1X) console.error('Erro ao gravar sinal (1X):', erroInsert1X.message);
          else totalGerados++;
        }
      }
    }
  }

  console.log(`Sinais gerados: ${totalGerados}`);
  if (totalGerados === 0) {
    console.log('(Nenhuma partida com status "agendado" encontrada -- normal enquanto só temos temporadas já finalizadas.)');
  }
}

// ---------- Fluxo principal ----------

async function main() {
  const args = process.argv.slice(2);
  const competicaoArg = args.find((a) => a.startsWith('--competicao='));

  if (args.includes('--calibrar')) {
    await modoCalibrar(competicaoArg);
  } else if (args.includes('--gerar')) {
    await modoGerar(competicaoArg);
  } else {
    console.log('Uso: node scripts/gerar-sinais.js --calibrar [--competicao=71]');
    console.log('  ou: node scripts/gerar-sinais.js --gerar [--competicao=71]');
  }
}

main().catch((err) => { console.error('Erro:', err); process.exit(1); });
