/**
 * gerar-sinais.js
 *
 * Pipeline de geração de sinais de verdade -- conecta o "fator combinado"
 * validado (diferença de ataque em casa + diferença de defesa fora, ambas
 * comparadas à média da liga) com as tabelas `sinais` e `estatisticas_modelo`
 * do schema.
 *
 * Tem 2 modos:
 *
 *  --calibrar
 *    Roda o backtest histórico (walk-forward, sem olhar o futuro) em todas
 *    as competições ativas, calcula a taxa de acerto REAL de cada nível de
 *    confiança, e grava isso em `estatisticas_modelo` -- essa é a base do
 *    disclaimer transparente ("sinais de alta confiança acertaram X% dos
 *    últimos N casos").
 *
 *  --gerar
 *    Olha as partidas com status='agendado' (jogos futuros ainda não
 *    disputados) e gera sinais reais pra elas, salvando em `sinais`.
 *    OBS: só funciona quando existirem partidas agendadas de verdade no
 *    banco -- o que só vai acontecer depois do upgrade pro plano pago (que
 *    dá acesso à temporada atual). Por enquanto, com só temporadas
 *    2022-2024 (todas já finalizadas), não há "jogos futuros" pra gerar
 *    sinal -- mas o pipeline já fica pronto pra quando existirem.
 *
 * Uso:
 *   node scripts/gerar-sinais.js --calibrar --competicao=71
 *   node scripts/gerar-sinais.js --calibrar          (todas as competições ativas)
 *   node scripts/gerar-sinais.js --gerar --competicao=71
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
const JANELA_AMOSTRA_PADRAO = 200; // "últimos N casos" mencionados no disclaimer

// Limiares de confiança, validados via scripts/testar-seletividade.js e
// scripts/validar-seletividade-outras.js (4 competições confirmaram o padrão).
const LIMIAR_BAIXA = 0;
const LIMIAR_MEDIA = 0.3;
const LIMIAR_ALTA = 0.7;

function nivelConfianca(fator) {
  if (fator > LIMIAR_ALTA) return 'alta';
  if (fator > LIMIAR_MEDIA) return 'media';
  if (fator > LIMIAR_BAIXA) return 'baixa';
  return null; // fator <= 0: não geramos sinal (sem indicação de vantagem pro mandante)
}

/**
 * Calcula o fator combinado pra um confronto específico, usando só histórico
 * anterior à data de referência (sem olhar o futuro).
 */
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

// ---------- Mercado de GOLS (2+ e 3+), validado via scripts/regras-percentual-gols.js ----------

const JANELA_GOLS = 10;

/**
 * Calcula a diferença percentual entre a "média do confronto" (média do
 * mandante como mandante + média do visitante como visitante, dividida por
 * 2) e a "média da liga" (gols por time por partida) -- validado em
 * scripts/regras-percentual-gols.js e scripts/validar-regras-percentual.js.
 */
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

// Faixas exatamente como validado -- '2' e '3+' são mutuamente exclusivas aqui
// (mesma definição usada no teste que confirmamos em Série A/B/C).
// '1mais' também é incluída, mas com uma ressalva importante: a vantagem
// estatística sobre a linha de base é muito pequena (~+0,7pp na Série A) --
// não é um "sinal forte", é só a probabilidade alta e honesta desse mercado,
// útil como perna de aposta múltipla (não distorce muito a odd combinada),
// não como sinal de vantagem.
function classificarFaixaGols(diffPercentual) {
  if (diffPercentual > 30) return '3mais';
  if (diffPercentual > 10) return '2mais';
  if (diffPercentual >= -10) return '1mais';
  return null; // abaixo disso, não geramos sinal de gols (não validado)
}

// ---------- Mercado X2 (empate ou fora), validado via scripts/validar-dupla-hipotese.js ----------
// Usa o motor de Poisson + Dixon-Coles completo (mesma calibração de
// scripts/calcular-sinais.js: janela=25, meia-vida=60, rho=-0.13).

const JANELA_POISSON = 25;
const MEIA_VIDA_POISSON = 60;
const MAX_GOLS_POISSON = 8;
const RHO_DIXON_COLES = -0.13;

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

/**
 * Devolve true se o modelo indica X2 (empate ou fora) como a dupla hipótese
 * mais provável entre 1X, X2 e 12 -- validado nas 4 competições.
 */
function preverX2(partidasAnteriores, timeCasaId, timeForaId, dataReferencia) {
  const { mediaGolsCasa, mediaGolsFora } = calcularMediasLigaPoisson(partidasAnteriores, dataReferencia);
  const fc = calcularForcaTimePoisson(partidasAnteriores, timeCasaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  const ff = calcularForcaTimePoisson(partidasAnteriores, timeForaId, dataReferencia, mediaGolsCasa, mediaGolsFora);
  if (fc.totalJogos < 6 || ff.totalJogos < 6) return null;

  const gec = mediaGolsCasa * fc.ataqueCasa * ff.defesaFora;
  const gef = mediaGolsFora * ff.ataqueFora * fc.defesaCasa;
  const { pCasa, pEmpate, pFora } = preverProbabilidadesPoisson(gec, gef);

  const p1X = pCasa + pEmpate;
  const pX2 = pEmpate + pFora;
  const p12 = pCasa + pFora;
  const duplas = { '1X': p1X, 'X2': pX2, '12': p12 };
  const previstaDupla = Object.entries(duplas).sort((a, b) => b[1] - a[1])[0][0];

  return previstaDupla === 'X2';
}

// ---------- Modo --calibrar ----------

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

  const porNivel = { alta: [], media: [], baixa: [] };
  const porFaixaGols = { '1mais': [], '2mais': [], '3mais': [] };
  const casosX2 = []; // true/false: acertou quando o modelo indicou X2 como dupla mais provável

  for (let i = 0; i < todasPartidas.length; i++) {
    const partida = todasPartidas[i];
    const anteriores = todasPartidas.slice(0, i);

    // Mercado: vitória do mandante
    const fator = calcularFatorCombinado(anteriores, partida.time_casa_id, partida.time_fora_id);
    if (fator !== null) {
      const nivel = nivelConfianca(fator);
      if (nivel) porNivel[nivel].push(partida.gols_casa > partida.gols_fora);
    }

    // Mercado: gols (1+, 2+ e 3+)
    const diffPercentual = calcularDiffPercentualGols(anteriores, partida.time_casa_id, partida.time_fora_id);
    if (diffPercentual !== null) {
      const faixa = classificarFaixaGols(diffPercentual);
      const golsTotais = partida.gols_casa + partida.gols_fora;
      if (faixa === '1mais') porFaixaGols['1mais'].push(golsTotais >= 1);
      if (faixa === '2mais') porFaixaGols['2mais'].push(golsTotais >= 2);
      if (faixa === '3mais') porFaixaGols['3mais'].push(golsTotais >= 3);
    }

    // Mercado: dupla hipótese X2 (empate ou fora)
    const modeloIndicaX2 = preverX2(anteriores, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
    if (modeloIndicaX2 === true) {
      const resultouEmX2 = partida.gols_casa <= partida.gols_fora; // empate ou vitória de fora
      casosX2.push(resultouEmX2);
    }
  }

  const resultados = [];
  const MINIMO_AMOSTRA_CONFIAVEL = 60; // abaixo disso, não é confiável o suficiente pra exibir como estatística pública

  for (const nivel of ['alta', 'media', 'baixa']) {
    const casos = porNivel[nivel];
    if (casos.length < 10) continue; // nem guarda, é ruído demais
    const acertos = casos.filter((x) => x).length;
    const taxaAcerto = acertos / casos.length;
    const confiavel = casos.length >= MINIMO_AMOSTRA_CONFIAVEL;

    resultados.push({ competicaoId, nomeCompeticao, mercado: 'vitoria_casa', nivel, amostra: casos.length, taxaAcerto, confiavel });

    const aviso = confiavel ? '' : '  ⚠️  AMOSTRA PEQUENA -- não exibir como estatística pública ainda';
    console.log(`  ${nomeCompeticao} [vitória do mandante] -- confiança ${nivel}: ${casos.length} casos, taxa de acerto ${(taxaAcerto * 100).toFixed(1)}%${aviso}`);
  }

  for (const faixa of ['1mais', '2mais', '3mais']) {
    const casos = porFaixaGols[faixa];
    if (casos.length < 10) continue;
    const acertos = casos.filter((x) => x).length;
    const taxaAcerto = acertos / casos.length;
    const confiavel = casos.length >= MINIMO_AMOSTRA_CONFIAVEL;

    resultados.push({ competicaoId, nomeCompeticao, mercado: `gols_${faixa}`, nivel: 'padrao', amostra: casos.length, taxaAcerto, confiavel });

    const rotulo = faixa === '1mais' ? '1+' : faixa === '2mais' ? '2+' : '3+';
    const aviso = confiavel ? '' : '  ⚠️  AMOSTRA PEQUENA -- não exibir como estatística pública ainda';
    console.log(`  ${nomeCompeticao} [gols ${rotulo}] -- ${casos.length} casos, taxa de acerto ${(taxaAcerto * 100).toFixed(1)}%${aviso}`);
  }

  if (casosX2.length >= 10) {
    const acertosX2 = casosX2.filter((x) => x).length;
    const taxaAcertoX2 = acertosX2 / casosX2.length;
    const confiavelX2 = casosX2.length >= MINIMO_AMOSTRA_CONFIAVEL;

    resultados.push({ competicaoId, nomeCompeticao, mercado: 'dupla_x2', nivel: 'padrao', amostra: casosX2.length, taxaAcerto: taxaAcertoX2, confiavel: confiavelX2 });

    const aviso = confiavelX2 ? '' : '  ⚠️  AMOSTRA PEQUENA -- não exibir como estatística pública ainda';
    console.log(`  ${nomeCompeticao} [dupla hipótese X2] -- ${casosX2.length} casos, taxa de acerto ${(taxaAcertoX2 * 100).toFixed(1)}%${aviso}`);
  }

  return resultados;
}

async function modoCalibrar(competicaoArg) {
  let query = supabase.from('competicoes').select('id, nome, api_football_id').eq('ativa', true);
  if (competicaoArg) query = query.eq('api_football_id', parseInt(competicaoArg.split('=')[1], 10));

  const { data: competicoes, error } = await query;
  if (error) throw error;

  console.log('Calibrando níveis de confiança (mercados: vitória do mandante + gols 1+/2+/3+ + dupla hipótese X2)...\n');

  const todosResultados = [];
  for (const comp of competicoes) {
    const resultados = await calibrarCompeticao(comp.id, comp.nome);
    todosResultados.push(...resultados);
  }

  const resultadosConfiaveis = todosResultados.filter((r) => r.confiavel);
  const resultadosDescartados = todosResultados.filter((r) => !r.confiavel);

  if (resultadosDescartados.length > 0) {
    console.log(`\n⚠️  ${resultadosDescartados.length} resultado(s) com amostra pequena demais NÃO serão gravados (evita mostrar estatística não confiável, tipo "100% de acerto" com 11 casos):`);
    for (const r of resultadosDescartados) {
      console.log(`   - ${r.nomeCompeticao} / ${r.nivel} (${r.amostra} casos)`);
    }
  }

  console.log(`\nGravando ${resultadosConfiaveis.length} registros confiáveis em estatisticas_modelo...`);
  for (const r of resultadosConfiaveis) {
    const { error } = await supabase.from('estatisticas_modelo').insert({
      tipo_mercado: `${r.mercado}_${r.nomeCompeticao.toLowerCase().replace(/\s+/g, '_')}`,
      nivel_confianca: r.nivel,
      janela_amostra: r.amostra,
      taxa_acerto: r.taxaAcerto,
      ev_medio: null, // precisa de odds reais pra calcular EV -- ainda não temos
    });
    if (error) console.error(`  Erro ao gravar (${r.nomeCompeticao}, ${r.mercado}, ${r.nivel}):`, error.message);
  }
  console.log('Calibração concluída.');
}

// ---------- Modo --gerar ----------

async function modoGerar(competicaoArg) {
  let query = supabase.from('competicoes').select('id, nome, api_football_id').eq('ativa', true);
  if (competicaoArg) query = query.eq('api_football_id', parseInt(competicaoArg.split('=')[1], 10));

  const { data: competicoes, error } = await query;
  if (error) throw error;

  let totalGerados = 0;

  for (const comp of competicoes) {
    const { data: partidasAgendadas } = await supabase
      .from('partidas')
      .select('id, data_hora, time_casa_id, time_fora_id')
      .eq('competicao_id', comp.id)
      .eq('status', 'agendado');

    if (!partidasAgendadas || partidasAgendadas.length === 0) continue;

    const { data: historico } = await supabase
      .from('partidas')
      .select('id, data_hora, time_casa_id, time_fora_id, gols_casa, gols_fora')
      .eq('competicao_id', comp.id).eq('status', 'finalizado').not('gols_casa', 'is', null)
      .order('data_hora', { ascending: true });

    for (const partida of partidasAgendadas) {
      // Mercado: vitória do mandante
      const fator = calcularFatorCombinado(historico, partida.time_casa_id, partida.time_fora_id);
      if (fator !== null) {
        const nivel = nivelConfianca(fator);
        if (nivel) {
          const { data: calibracao } = await supabase
            .from('estatisticas_modelo')
            .select('taxa_acerto')
            .eq('tipo_mercado', `vitoria_casa_${comp.nome.toLowerCase().replace(/\s+/g, '_')}`)
            .eq('nivel_confianca', nivel)
            .order('calculado_em', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (calibracao?.taxa_acerto != null) {
            const { error: erroInsert } = await supabase.from('sinais').insert({
              partida_id: partida.id,
              tipo_mercado: 'vitoria_casa',
              probabilidade_modelo: calibracao.taxa_acerto,
              nivel_confianca: nivel,
              pacote_minimo: 'basico',
            });
            if (erroInsert) console.error('Erro ao gravar sinal (vitória casa):', erroInsert.message);
            else totalGerados++;
          }
        }
      }

      // Mercado: gols (2+ e 3+)
      const diffPercentual = calcularDiffPercentualGols(historico, partida.time_casa_id, partida.time_fora_id);
      if (diffPercentual !== null) {
        const faixa = classificarFaixaGols(diffPercentual);
        if (faixa) {
          const { data: calibracaoGols } = await supabase
            .from('estatisticas_modelo')
            .select('taxa_acerto')
            .eq('tipo_mercado', `gols_${faixa}_${comp.nome.toLowerCase().replace(/\s+/g, '_')}`)
            .eq('nivel_confianca', 'padrao')
            .order('calculado_em', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (calibracaoGols?.taxa_acerto != null) {
            const { error: erroInsertGols } = await supabase.from('sinais').insert({
              partida_id: partida.id,
              tipo_mercado: `gols_${faixa}`,
              probabilidade_modelo: calibracaoGols.taxa_acerto,
              nivel_confianca: 'padrao',
              pacote_minimo: 'basico',
            });
            if (erroInsertGols) console.error('Erro ao gravar sinal (gols):', erroInsertGols.message);
            else totalGerados++;
          }
        }
      }

      // Mercado: dupla hipótese X2 (empate ou fora)
      const modeloIndicaX2 = preverX2(historico, partida.time_casa_id, partida.time_fora_id, partida.data_hora);
      if (modeloIndicaX2 === true) {
        const { data: calibracaoX2 } = await supabase
          .from('estatisticas_modelo')
          .select('taxa_acerto')
          .eq('tipo_mercado', `dupla_x2_${comp.nome.toLowerCase().replace(/\s+/g, '_')}`)
          .eq('nivel_confianca', 'padrao')
          .order('calculado_em', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (calibracaoX2?.taxa_acerto != null) {
          const { error: erroInsertX2 } = await supabase.from('sinais').insert({
            partida_id: partida.id,
            tipo_mercado: 'dupla_x2',
            probabilidade_modelo: calibracaoX2.taxa_acerto,
            nivel_confianca: 'padrao',
            pacote_minimo: 'basico',
          });
          if (erroInsertX2) console.error('Erro ao gravar sinal (X2):', erroInsertX2.message);
          else totalGerados++;
        }
      }
    }
  }

  console.log(`Sinais gerados: ${totalGerados}`);
  if (totalGerados === 0) {
    console.log('(Nenhuma partida com status "agendado" encontrada -- normal enquanto só temos temporadas 2022-2024, todas já finalizadas. Isso vai funcionar quando tivermos jogos futuros reais, após o upgrade de plano.)');
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
