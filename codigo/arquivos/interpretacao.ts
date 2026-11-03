import type { Posicao } from '../dominio/tipos.js';

export const CABECALHO = 'idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida';

// Campos citados podem conter ponto e vírgula. Aspas internas são escapadas com duas aspas.
export function interpretarCsv(line: string): string[] {
  // Caminho rápido: sem aspas o resultado do parser completo equivale a um split simples.
  if (line.indexOf('"') === -1) return line.split(';');
  const fields: string[] = [];
  let value = '', quoted = false, closed = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else value += c;
    } else if (c === ';') {
      fields.push(value); value = ''; closed = false;
    } else if (c === '"') {
      if (value !== '' || closed) throw new Error('Aspas em posição inválida.');
      quoted = true;
    } else {
      if (closed) throw new Error('Conteúdo após fechamento de aspas.');
      value += c;
    }
  }
  if (quoted) throw new Error('Aspas não fechadas; campos multilinha não são aceitos.');
  fields.push(value);
  return fields;
}

function interpretarIdentificador(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('ID deve ser inteiro decimal não negativo.');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('ID fora da faixa segura.');
  return n;
}

// Equivale a /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/ sem o custo da expressão regular por registro.
function coordenadaBemFormada(value: string): boolean {
  let i = 0;
  const n = value.length;
  const c0 = value.charCodeAt(0);
  if (c0 === 43 || c0 === 45) i = 1;
  let inteiros = 0, fracao = 0;
  for (; i < n; i++) { const c = value.charCodeAt(i); if (c < 48 || c > 57) break; inteiros++; }
  if (i < n) {
    if (value.charCodeAt(i) !== 46) return false;
    for (i++; i < n; i++) { const c = value.charCodeAt(i); if (c < 48 || c > 57) return false; fracao++; }
    return fracao > 0;
  }
  return inteiros > 0;
}

function interpretarCoordenada(value: string, min: number, max: number): number {
  if (!coordenadaBemFormada(value)) throw new Error('Coordenada decimal inválida.');
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error('Coordenada fora da faixa.');
  return n;
}

// Registros consecutivos costumam repetir o timestamp; só o último valor aprovado é memorizado.
let ultimoTimestampValido = '';

export function dataHoraValida(value: string): boolean {
  if (value === ultimoTimestampValido) return true;
  const ok = dataHoraValidaCompleta(value);
  if (ok) ultimoTimestampValido = value;
  return ok;
}

function dataHoraValidaCompleta(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && Number(value.slice(11, 13)) <= 23 && Number(value.slice(14, 16)) <= 59 && Number(value.slice(17, 19)) <= 59;
}

export function interpretarRegistro(line: string, lineNumber = 0): Posicao {
  try {
    const f = interpretarCsv(line);
    if (f.length !== 7) throw new Error('Esperados exatamente 7 campos separados por ponto e vírgula.');
    const [rawId, rawFaction, timestamp, rawLat, rawLon, rawVictim, rawRestrictions] = f as [string,string,string,string,string,string,string];
    const id = interpretarIdentificador(rawId);
    if (!dataHoraValida(timestamp)) throw new Error('Timestamp inválido.');
    if (rawVictim !== 'true' && rawVictim !== 'false') throw new Error('Booleano deve ser true ou false.');
    if (rawFaction !== '') interpretarIdentificador(rawFaction);
    const vitima = rawVictim === 'true';
    const restricoes = rawRestrictions === '' ? [] : [...new Set(rawRestrictions.split(',').map(interpretarIdentificador))].sort((a,b) => a-b);
    if (restricoes.includes(id)) throw new Error('Restrição não pode apontar para o próprio ID.');
    if (vitima && rawFaction !== '') throw new Error('Vítima não pode possuir facção.');
    if (!vitima && restricoes.length > 0) throw new Error('Monitorado sem medida protetiva não pode possuir restrições.');
    return { id, faccao: rawFaction || null, timestamp, lat: interpretarCoordenada(rawLat, -90, 90), lon: interpretarCoordenada(rawLon, -180, 180), vitima, restricoes };
  } catch (error) {
    throw new Error(`Linha ${lineNumber}: ${error instanceof Error ? error.message : 'registro inválido'}`);
  }
}
