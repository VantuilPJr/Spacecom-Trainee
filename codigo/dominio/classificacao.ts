import type { TipoEncontro, Posicao } from './tipos.js';

// Retornar null exclui pares sem relacionamento elegível, mesmo quando ocupam a mesma posição.
export function classificarPar(a: Posicao, b: Posicao): TipoEncontro | null {
  if (a.id === b.id || a.timestamp !== b.timestamp) return null;
  if (!a.vitima && !b.vitima) {
    return a.faccao !== null && a.faccao !== '' && a.faccao === b.faccao
      ? 'faccao'
      : 'generico';
  }
  if (a.vitima && b.vitima) return null;
  const vitima = a.vitima ? a : b;
  const aggressor = a.vitima ? b : a;
  return vitima.restricoes.includes(aggressor.id) ? 'protetiva' : null;
}
