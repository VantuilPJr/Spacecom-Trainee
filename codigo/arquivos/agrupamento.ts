import type { Posicao } from '../dominio/tipos.js';

export class ErroOrdemTemporal extends Error {
  constructor() { super('Timestamps fora de ordem; utilize ordenação automática ou externa.'); }
}

export async function* agruparPosicoes(records: AsyncIterable<Posicao>, maxGroupRecords = 250_000): AsyncGenerator<Posicao[]> {
  async function* lotesUnitarios(): AsyncGenerator<Posicao[]> {
    for await (const registro of records) yield [registro];
  }
  yield* agruparLotesPosicoes(lotesUnitarios(), maxGroupRecords);
}

export async function* agruparLotesPosicoes(lotes: AsyncIterable<readonly Posicao[]>, maxGroupRecords = 250_000): AsyncGenerator<Posicao[]> {
  let timestamp: string | undefined;
  let ids = new Map<number, Posicao>();
  let estimatedBytes = 0;
  for await (const lote of lotes) {
    for (const p of lote) {
      if (timestamp !== undefined && p.timestamp < timestamp) throw new ErroOrdemTemporal();
      if (timestamp !== undefined && p.timestamp !== timestamp) {
        yield [...ids.values()];
        ids = new Map();
        estimatedBytes = 0;
      }
      timestamp = p.timestamp;
      const previous = ids.get(p.id);
      if (previous) {
        if (previous.lat !== p.lat || previous.lon !== p.lon || previous.faccao !== p.faccao || previous.vitima !== p.vitima || previous.restricoes.join(',') !== p.restricoes.join(',')) {
          throw new Error('Registros conflitantes para o mesmo ID e timestamp.');
        }
      } else {
        if (ids.size >= maxGroupRecords) throw new Error('Grupo temporal excede limite de registros.');
        // O orçamento considera a posição e suas restrições para barrar grupos excessivos antes da detecção.
        // É uma estimativa lógica. Mapas, objetos e o runtime também consomem memória.
        estimatedBytes += 256 + (p.faccao?.length ?? 0) * 2 + p.restricoes.length * 16;
        if (estimatedBytes > 64 * 1024 * 1024) throw new Error('Grupo temporal excede orçamento estimado de memória (64 MiB).');
        ids.set(p.id, p);
      }
    }
  }
  if (ids.size > 0) yield [...ids.values()];
}
