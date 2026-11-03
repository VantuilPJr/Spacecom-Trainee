import { dataHoraValida, interpretarRegistro } from './interpretacao.js';
import type { Posicao } from '../dominio/tipos.js';

// Caminho rápido: interpreta diretamente os bytes ASCII de uma linha, sem criar strings intermediárias.
// Só aceita o formato canônico (IDs sem zeros à esquerda, coordenadas decimais simples, restrições vazias).
// Qualquer linha fora desse formato retorna null e é tratada pelo parser completo, que valida e reporta erros.

const POTENCIAS_10 = [1, 10, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

let tsBytes: Buffer = Buffer.alloc(19);
let tsString = '';

// Resultados do último campo lido (evita alocar tuplas por registro).
let cursor = 0;

function lerInteiro(buf: Buffer, i: number, fim: number): number {
  // Retorna -1 se o campo não for um inteiro canônico de até 15 dígitos; deixa o cursor no delimitador.
  const inicio = i;
  let v = 0;
  while (i < fim) {
    const c = buf[i]!;
    if (c < 48 || c > 57) break;
    v = v * 10 + (c - 48);
    i++;
  }
  const n = i - inicio;
  cursor = i;
  if (n === 0 || n > 15) return -1;
  if (n > 1 && buf[inicio] === 48) return -1;
  return v;
}

function lerCoordenada(buf: Buffer, i: number, fim: number, limite: number): number {
  // Retorna NaN se fora do formato simples ou da faixa; o cursor fica no delimitador.
  let negativo = false;
  const c0 = buf[i];
  if (c0 === 45) { negativo = true; i++; } else if (c0 === 43) i++;
  let mantissa = 0, digitos = 0, fracao = -1;
  while (i < fim) {
    const c = buf[i]!;
    if (c === 46) {
      if (fracao !== -1) return NaN;
      fracao = 0;
    } else if (c >= 48 && c <= 57) {
      mantissa = mantissa * 10 + (c - 48);
      digitos++;
      if (fracao !== -1) fracao++;
    } else break;
    i++;
  }
  cursor = i;
  // Mantissa e potência de 10 exatas em double: a divisão é corretamente arredondada, igual a Number(texto).
  if (digitos === 0 || digitos > 15 || fracao === 0) return NaN;
  if (fracao === -1) fracao = 0;
  const valor = mantissa / POTENCIAS_10[fracao]!;
  if (valor > limite) return NaN;
  return negativo ? -valor : valor;
}

export function interpretarLinhaRapida(buf: Buffer, inicio: number, fim: number): Posicao | null {
  const id = lerInteiro(buf, inicio, fim);
  if (id < 0 || buf[cursor] !== 59) return null;
  let i = cursor + 1;

  let faccao: string | null = null;
  if (buf[i] !== 59) {
    const f = lerInteiro(buf, i, fim);
    if (f < 0 || buf[cursor] !== 59) return null;
    faccao = String(f);
    i = cursor;
  }
  i++;

  if (i + 20 > fim) return null;
  const aspasTs = buf[i] === 34;
  if (aspasTs) i++;
  if (i + 19 > fim || buf[i + 19] !== (aspasTs ? 34 : 59)) return null;
  let igual = tsString !== '';
  for (let k = 0; k < 19; k++) {
    const b = buf[i + k]!;
    if (igual && b !== tsBytes[k]) igual = false;
  }
  if (!igual) {
    const texto = buf.toString('latin1', i, i + 19);
    if (!dataHoraValida(texto)) return null;
    tsString = texto;
    tsBytes = Buffer.from(texto, 'latin1');
  }
  i += 19;
  if (aspasTs) i++;
  if (buf[i] !== 59) return null;
  i++;

  const lat = lerCoordenada(buf, i, fim, 90);
  if (lat !== lat || buf[cursor] !== 59) return null;
  i = cursor + 1;
  const lon = lerCoordenada(buf, i, fim, 180);
  if (lon !== lon || buf[cursor] !== 59) return null;
  i = cursor + 1;

  let vitima: boolean;
  if (i + 5 <= fim && buf[i] === 102 && buf[i + 1] === 97 && buf[i + 2] === 108 && buf[i + 3] === 115 && buf[i + 4] === 101) {
    vitima = false; i += 5;
  } else if (i + 4 <= fim && buf[i] === 116 && buf[i + 1] === 114 && buf[i + 2] === 117 && buf[i + 3] === 101) {
    vitima = true; i += 4;
  } else return null;

  // Sétimo campo: vazio ou lista de IDs canônicos (com ou sem aspas), como no parser completo.
  if (buf[i] !== 59) return null;
  i++;
  if (i === fim) {
    if (vitima && faccao !== null) return null;
    return { id, faccao, timestamp: tsString, lat, lon, vitima, restricoes: [] };
  }
  if (!vitima) return null;
  const aspas = buf[i] === 34;
  if (aspas) i++;
  const lista: number[] = [];
  for (;;) {
    const r = lerInteiro(buf, i, fim);
    if (r < 0 || r === id) return null;
    if (lista.indexOf(r) === -1) lista.push(r);
    i = cursor;
    if (buf[i] === 44) { i++; continue; }
    break;
  }
  if (aspas) { if (buf[i] !== 34) return null; i++; }
  if (i !== fim || faccao !== null) return null;
  if (lista.length > 1) lista.sort((a, b) => a - b);
  return { id, faccao, timestamp: tsString, lat, lon, vitima, restricoes: lista };
}

export function interpretarLinhaBytes(buf: Buffer, inicio: number, fim: number, numeroLinha: number): Posicao {
  const rapida = interpretarLinhaRapida(buf, inicio, fim);
  if (rapida !== null) return rapida;
  // Decodificação estrita preserva a rejeição de UTF-8 inválido do parser original.
  const texto = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(inicio, fim));
  return interpretarRegistro(texto, numeroLinha);
}
