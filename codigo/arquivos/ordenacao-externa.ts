import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Posicao } from '../dominio/tipos.js';
import { lerLinhas, lerPosicoes } from './leitura.js';

const LEITORES_POR_ETAPA = 32;
const BYTES_POR_LOTE = 32 * 1024 * 1024;
const compararPosicoes = (a: Posicao, b: Posicao): number => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id - b.id;

async function* lerLote(path: string): AsyncGenerator<Posicao> {
  for await (const line of lerLinhas(path, 262_144)) yield JSON.parse(line) as Posicao;
}

async function gravarLote(path: string, records: AsyncIterable<Posicao>): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  let buffer = '';
  try {
    for await (const p of records) {
      buffer += JSON.stringify(p) + '\n';
      if (buffer.length >= 256 * 1024) { await file.writeFile(buffer); buffer = ''; }
    }
    if (buffer) await file.writeFile(buffer);
  } finally { await file.close(); }
}

async function* intercalarLotes(caminhos: string[]): AsyncGenerator<Posicao> {
  const readers = caminhos.map(path => lerLote(path));
  try {
    const heads = await Promise.all(readers.map(reader => reader.next()));
    for (;;) {
      let best = -1;
      for (let i = 0; i < heads.length; i++) {
        const head = heads[i]!;
        if (!head.done && (best === -1 || compararPosicoes(head.value, heads[best]!.value as Posicao) < 0)) best = i;
      }
      if (best === -1) return;
      yield heads[best]!.value as Posicao;
      heads[best] = await readers[best]!.next();
    }
  } finally { await Promise.all(readers.map(reader => reader.return(undefined))); }
}

// Lotes limitados por registros e bytes evitam ordenar o arquivo inteiro na memória. A intercalação abre no máximo 32 leitores.
export async function* ordenarExternamente(input: string, directory: string, chunkRecords = 50_000): AsyncGenerator<Posicao> {
  if (!Number.isSafeInteger(chunkRecords) || chunkRecords < 1) throw new Error('chunkRecords deve ser inteiro positivo.');
  await mkdir(directory, { recursive: true });
  let count = 0, chunk: Posicao[] = [], bytes = 0;
  const caminhoLote = (level: number, index: number): string => join(directory, `lote-${level}-${index}.jsonl`);
  async function flush(): Promise<void> {
    chunk.sort(compararPosicoes);
    const records = chunk;
    await gravarLote(caminhoLote(0, count++), (async function* () { yield* records; })());
    chunk = []; bytes = 0;
  }
  for await (const p of lerPosicoes(input)) {
    chunk.push(p); bytes += Buffer.byteLength(JSON.stringify(p));
    if (chunk.length >= chunkRecords || bytes >= BYTES_POR_LOTE) await flush();
  }
  if (chunk.length > 0) await flush();
  let level = 0;
  while (count > 1) {
    let nextCount = 0;
    for (let first = 0; first < count; first += LEITORES_POR_ETAPA) {
      const paths = Array.from({ length: Math.min(LEITORES_POR_ETAPA, count - first) }, (_, i) => caminhoLote(level, first + i));
      await gravarLote(caminhoLote(level + 1, nextCount++), intercalarLotes(paths));
      await Promise.all(paths.map(path => unlink(path)));
    }
    level++; count = nextCount;
  }
  if (count === 1) yield* lerLote(caminhoLote(level, 0));
}
