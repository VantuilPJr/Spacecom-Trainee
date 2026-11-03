import { classificarPar } from '../dominio/classificacao.js';
import type { Encontro, TipoEncontro, Posicao } from '../dominio/tipos.js';
import { LIMITE_ENCONTRO_METROS, haversine, converterParaEcef } from '../geografia/coordenadas.js';
import { GradeEspacial } from '../geografia/grade.js';

export type Estrategia = 'brute' | 'grid' | 'adaptive';
export const LIMIAR_BUSCA_DIRETA = 4096;

export interface MetricasDeteccao {
  candidatePairs: number;
  haversineCalls: number;
  encounters: number;
  bruteGroups: number;
  gridGroups: number;
}

export function criarMetricasDeteccao(): MetricasDeteccao {
  return { candidatePairs: 0, haversineCalls: 0, encounters: 0, bruteGroups: 0, gridGroups: 0 };
}

function criarEncontro(
  a: Posicao,
  b: Posicao,
  tipo: TipoEncontro,
  metricas: MetricasDeteccao,
): Encontro | null {
  metricas.candidatePairs++;
  metricas.haversineCalls++;
  const distancia = haversine(a, b);
  if (!Number.isFinite(distancia)) throw new Error('Distância não finita no motor de detecção.');
  if (distancia >= LIMITE_ENCONTRO_METROS) return null;
  const primeiro = a.id < b.id ? a : b;
  const segundo = a.id < b.id ? b : a;
  metricas.encounters++;
  return {
    tipo: tipo,
    monitoradosEncontro: [primeiro.id, segundo.id],
    timestamp: primeiro.timestamp,
    posicoes: {
      [primeiro.id]: { lat: primeiro.lat, lon: primeiro.lon },
      [segundo.id]: { lat: segundo.lat, lon: segundo.lon },
    },
    distanciaMetros: distancia,
  };
}

// O grupo já deve estar validado e sem IDs repetidos. A emissão por gerador permite gravar encontros sem retê-los entre instantes.
export function* detectarEncontros(
  grupo: readonly Posicao[],
  estrategia: Estrategia,
  metricas: MetricasDeteccao,
  limiar = LIMIAR_BUSCA_DIRETA,
): Generator<Encontro> {
  if (!Number.isSafeInteger(limiar) || limiar < 0) {
    throw new Error('Limite da estratégia adaptativa inválido.');
  }
  if (estrategia !== 'brute' && estrategia !== 'grid' && estrategia !== 'adaptive') {
    throw new Error('Estratégia de detecção inválida.');
  }
  if (grupo.length === 0) return;
  const timestamp = grupo[0]?.timestamp;
  const posicoesPorId = new Map<number, Posicao>();
  for (const posicao of grupo) {
    if (posicao.timestamp !== timestamp) throw new Error('Grupo contém timestamps diferentes.');
    if (posicoesPorId.has(posicao.id)) throw new Error('Grupo contém IDs duplicados.');
    posicoesPorId.set(posicao.id, posicao);
  }

  if (estrategia === 'brute') {
    metricas.bruteGroups++;
    // A referência avalia os pares sem filtro espacial para revelar possíveis omissões das estratégias otimizadas.
    for (let i = 0; i < grupo.length; i++) {
      const a = grupo[i]!;
      for (let j = i + 1; j < grupo.length; j++) {
        const b = grupo[j]!;
        const tipo = classificarPar(a, b);
        if (tipo === null) continue;
        const encontro = criarEncontro(a, b, tipo, metricas);
        if (encontro !== null) yield encontro;
      }
    }
    return;
  }

  const monitorados = grupo.filter((posicao) => !posicao.vitima);
  if (estrategia === 'adaptive' && monitorados.length <= limiar) {
    metricas.bruteGroups++;
    // Varredura em latitude: ordena os índices por latitude e, para cada ponto, avança só enquanto a diferença
    // de latitude permanece ≤ 0,00018° (cerca de 20,015 m, folga sobre o limite estrito de 20 m).
    // Os pares avaliados são os mesmos do laço O(n²) com o mesmo descarte; só deixam de ser percorridos os distantes.
    const n = monitorados.length;
    const lats = new Float64Array(n);
    for (let i = 0; i < n; i++) lats[i] = monitorados[i]!.lat;
    const ordem = new Uint32Array(n);
    for (let i = 0; i < n; i++) ordem[i] = i;
    ordem.sort((x, y) => lats[x]! - lats[y]!);
    const achados: { i: number; j: number; encontro: Encontro }[] = [];
    for (let p = 0; p < n; p++) {
      const ia = ordem[p]!;
      const latA = lats[ia]!;
      for (let q = p + 1; q < n; q++) {
        const ib = ordem[q]!;
        if (lats[ib]! - latA > 0.00018) break;
        // Mantém a orientação do laço original: o primeiro argumento é o de menor índice no grupo.
        const i = ia < ib ? ia : ib, j = ia < ib ? ib : ia;
        const a = monitorados[i]!, b = monitorados[j]!;
        const tipo = classificarPar(a, b)!;
        const encontro = criarEncontro(a, b, tipo, metricas);
        if (encontro !== null) achados.push({ i, j, encontro });
      }
    }
    // Reproduz a ordem de emissão do laço original (por índice i, depois j).
    achados.sort((x, y) => x.i - y.i || x.j - y.j);
    for (const achado of achados) yield achado.encontro;
  } else {
    metricas.gridGroups++;
    const grade = new GradeEspacial<Posicao>();
    for (const posicao of monitorados) {
      const cartesiana = converterParaEcef(posicao);
      // Consultar antes de inserir garante que cada par de usuários seja visitado uma única vez.
      for (const candidato of grade.buscarCandidatos(cartesiana)) {
        const tipo = classificarPar(posicao, candidato)!;
        const encontro = criarEncontro(posicao, candidato, tipo, metricas);
        if (encontro !== null) yield encontro;
      }
      grade.inserir(cartesiana, posicao);
    }
  }

  // Somente vínculos explícitos geram encontros protetivos. O índice por ID evita procurar entre pessoas sem relação.
  for (const vitima of grupo) {
    if (!vitima.vitima) continue;
    for (const id of new Set(vitima.restricoes)) {
      const agressor = posicoesPorId.get(id);
      if (agressor === undefined || agressor.vitima) continue;
      const encontro = criarEncontro(vitima, agressor, 'protetiva', metricas);
      if (encontro !== null) yield encontro;
    }
  }
}
