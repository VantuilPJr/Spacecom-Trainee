import { createReadStream } from 'node:fs';
import { TextDecoder } from 'node:util';
import { CABECALHO, interpretarCsv } from './interpretacao.js';
import type { Posicao } from '../dominio/tipos.js';
import { interpretarLinhaBytes } from './leitura-rapida.js';

async function* lerBlocosLinhas(path: string, maxLineBytes = 65_536): AsyncGenerator<string[]> {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  try {
    for await (const chunk of stream) {
      pending += decoder.decode(chunk as Buffer, { stream: true });
      const linhas: string[] = [];
      let start = 0, end: number;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        let line = pending.slice(start, end);
        // Comprimento em UTF-16 nunca excede os bytes UTF-8 em mais de 3x; só mede bytes quando houver risco.
        if (line.length * 3 > maxLineBytes && Buffer.byteLength(line) > maxLineBytes) throw new Error('Linha excede limite de bytes.');
        if (line.endsWith('\r')) line = line.slice(0, -1);
        linhas.push(line);
        start = end + 1;
      }
      pending = pending.slice(start);
      if (Buffer.byteLength(pending) > maxLineBytes) throw new Error('Linha excede limite de bytes.');
      if (linhas.length > 0) yield linhas;
    }
    pending += decoder.decode();
    if (pending !== '') {
      if (Buffer.byteLength(pending) > maxLineBytes) throw new Error('Linha excede limite de bytes.');
      yield [pending.endsWith('\r') ? pending.slice(0, -1) : pending];
    }
  } finally { stream.destroy(); }
}

export async function* lerLinhas(path: string, maxLineBytes = 65_536): AsyncGenerator<string> {
  for await (const linhas of lerBlocosLinhas(path, maxLineBytes)) yield* linhas;
}

// Suspender a execução uma vez por bloco reduz o custo das promessas por registro.
// Cada linha ainda passa pelo mesmo parser e pelas mesmas validações.
function validarCabecalho(line: string): void {
  const fields = interpretarCsv(line.replace(/^\uFEFF/, ''));
  const expected = CABECALHO.split(';');
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) throw new Error('Cabeçalho inválido.');
}

// Lê o arquivo como bytes e interpreta cada linha direto no Buffer (ver leitura-rapida.ts).
// Linhas fora do formato canônico passam pelo parser completo, com as mesmas validações e mensagens.
export async function* lerLotesPosicoes(path: string, maxLineBytes = 65_536): AsyncGenerator<Posicao[]> {
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let lineNumber = 0;
  let resto: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      const buf = resto.length > 0 ? Buffer.concat([resto, chunk as Buffer]) : (chunk as Buffer);
      const posicoes: Posicao[] = [];
      let inicio = 0, fim: number;
      while ((fim = buf.indexOf(10, inicio)) !== -1) {
        let tamanho = fim;
        if (tamanho > inicio && buf[tamanho - 1] === 13) tamanho--;
        if (fim - inicio > maxLineBytes) throw new Error('Linha excede limite de bytes.');
        lineNumber++;
        if (lineNumber === 1) validarCabecalho(decoder.decode(buf.subarray(inicio, tamanho)));
        else posicoes.push(interpretarLinhaBytes(buf, inicio, tamanho, lineNumber));
        inicio = fim + 1;
      }
      resto = Buffer.from(buf.subarray(inicio));
      if (resto.length > maxLineBytes) throw new Error('Linha excede limite de bytes.');
      if (posicoes.length > 0) yield posicoes;
    }
    if (resto.length > 0) {
      let tamanho = resto.length;
      if (resto[tamanho - 1] === 13) tamanho--;
      lineNumber++;
      if (lineNumber === 1) validarCabecalho(decoder.decode(resto.subarray(0, tamanho)));
      else yield [interpretarLinhaBytes(resto, 0, tamanho, lineNumber)];
    }
    if (lineNumber === 0) throw new Error('Arquivo vazio: cabeçalho obrigatório.');
  } finally { stream.destroy(); }
}

export async function* lerPosicoes(path: string, maxLineBytes = 65_536): AsyncGenerator<Posicao> {
  for await (const lote of lerLotesPosicoes(path, maxLineBytes)) yield* lote;
}
