import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { interpretarRegistro } from '../arquivos/interpretacao.js';
import { interpretarLinhaBytes } from '../arquivos/leitura-rapida.js';
import { lerLotesPosicoes } from '../arquivos/leitura.js';
import type { Posicao } from '../dominio/tipos.js';

const CAB = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';

function viaBytes(linha: string): Posicao | 'erro' {
  const buf = Buffer.from(linha, 'utf8');
  try { return interpretarLinhaBytes(buf, 0, buf.length, 2); } catch { return 'erro'; }
}
function viaTexto(linha: string): Posicao | 'erro' {
  try { return interpretarRegistro(linha, 2); } catch { return 'erro'; }
}

test('caminho rápido equivale ao parser completo em linhas válidas e inválidas', () => {
  const linhas = [
    '1;;"2024-01-01 00:00:00";-30.75944;-70.62427;false;',
    '3;6;"2024-01-01 00:00:05";-29.82363;-64.27960;false;',
    '6;;"2024-01-01 00:00:00";-32.65060;-52.12939;true;"51"',
    '6;;"2024-01-01 00:00:00";-32.65060;-52.12939;true;"51,53,51"',
    '6;;"2024-01-01 00:00:00";-32.65060;-52.12939;true;53,51',
    '6;;2024-01-01 00:00:00;1.5;-2;false;',
    '0;;"2024-01-01 00:00:00";0;0;false;',
    '1;;"2024-01-01 00:00:00";-0.00000;+3.1;false;',
    '1;;"2024-01-01 00:00:00";.5;5.;false;',
    '01;;"2024-01-01 00:00:00";1;1;false;',
    '1;;"2024-02-30 00:00:00";1;1;false;',
    '1;;"2024-01-01 24:00:00";1;1;false;',
    '1;;"2024-01-01 00:00:00";91;1;false;',
    '1;;"2024-01-01 00:00:00";1;181;false;',
    '1;;"2024-01-01 00:00:00";1;1;talvez;',
    '1;;"2024-01-01 00:00:00";1;1;false',
    '1;;"2024-01-01 00:00:00";1;1;false;7',
    '6;4;"2024-01-01 00:00:00";1;1;true;"7"',
    '6;;"2024-01-01 00:00:00";1;1;true;"6"',
    '6;;"2024-01-01 00:00:00";1;1;true;"7',
    '1;;"2024-01-01 00:00:00";1.1234567890123456;1;false;',
    '1;;"2024-01-01 00:00:00";1e3;1;false;',
    '1;;"2024-01-01 00:00:00";1;1;true;',
    '',
    '1;2;3',
    'a;;"2024-01-01 00:00:00";1;1;false;',
  ];
  for (const linha of linhas) assert.deepEqual(viaBytes(linha), viaTexto(linha), `divergência em: ${linha}`);
});

test('caminho rápido equivale ao parser completo em linhas aleatórias', () => {
  let seed = 12345;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let k = 0; k < 20_000; k++) {
    const vit = rnd() < 0.2;
    const casas = Math.floor(rnd() * 7);
    const lat = ((rnd() - 0.5) * 180).toFixed(casas), lon = ((rnd() - 0.5) * 360).toFixed(casas);
    const id = Math.floor(rnd() * 5000);
    const fac = !vit && rnd() < 0.4 ? String(Math.floor(rnd() * 30)) : '';
    const res = vit ? `"${Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Math.floor(rnd() * 5000)).join(',')}"` : '';
    const linha = `${id};${fac};"2024-01-0${1 + Math.floor(rnd() * 9)} 00:00:0${Math.floor(rnd() * 10)}";${lat};${lon};${vit};${res}`;
    assert.deepEqual(viaBytes(linha), viaTexto(linha), `divergência em: ${linha}`);
  }
});

test('leitor em blocos conserva todas as linhas entre fronteiras de bloco, com CRLF e sem quebra final', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spacecom-teste-'));
  try {
    const linhas: string[] = [];
    for (let i = 0; i < 40_000; i++) linhas.push(`${i};${i % 7 === 0 ? '' : i % 5};"2024-01-01 00:00:${String(i % 60).padStart(2, '0')}";${(-30 + (i % 1000) / 1e5).toFixed(5)};${(-60 - (i % 777) / 1e5).toFixed(5)};false;`);
    const arquivo = join(dir, 'entrada.txt');
    await writeFile(arquivo, [CAB, ...linhas].join('\r\n'));
    const lidas: Posicao[] = [];
    for await (const lote of lerLotesPosicoes(arquivo)) lidas.push(...lote);
    assert.equal(lidas.length, linhas.length);
    linhas.forEach((linha, i) => assert.deepEqual(lidas[i], interpretarRegistro(linha, i + 2)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('leitor rejeita cabeçalho inválido, arquivo vazio e UTF-8 inválido', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spacecom-teste-'));
  try {
    const a = join(dir, 'a.txt'); await writeFile(a, 'x;y\n1;;"2024-01-01 00:00:00";1;1;false;\n');
    await assert.rejects(async () => { for await (const _ of lerLotesPosicoes(a)) void _; }, /Cabeçalho/);
    const b = join(dir, 'b.txt'); await writeFile(b, '');
    await assert.rejects(async () => { for await (const _ of lerLotesPosicoes(b)) void _; }, /vazio/);
    const c = join(dir, 'c.txt'); await writeFile(c, Buffer.concat([Buffer.from(`${CAB}\n1;`), Buffer.from([0xff]), Buffer.from(';"2024-01-01 00:00:00";1;1;false;\n')]));
    await assert.rejects(async () => { for await (const _ of lerLotesPosicoes(c)) void _; });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

