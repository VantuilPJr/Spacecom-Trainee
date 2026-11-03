import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criarMetricasDeteccao, detectarEncontros, type Estrategia } from '../deteccao/motor.js';
import { haversine } from '../geografia/coordenadas.js';
import type { Encontro, Posicao } from '../dominio/tipos.js';

const TS = '2024-01-01 00:00:00';
function pos(id: number, lat: number, lon: number, extra: Partial<Posicao> = {}): Posicao {
  return { id, faccao: null, timestamp: TS, lat, lon, vitima: false, restricoes: [], ...extra };
}
function rodar(grupo: Posicao[], estrategia: Estrategia, limiar?: number): Encontro[] {
  return [...detectarEncontros(grupo, estrategia, criarMetricasDeteccao(), limiar)];
}
const chave = (e: Encontro): string => `${e.tipo}|${e.monitoradosEncontro.join(',')}|${e.timestamp}`;

test('limite: menor que 20 m é encontro e 20 m exatos ou mais não é', () => {
  // Desloca a longitude até a distância ficar logo abaixo e logo acima de 20 m.
  const base = pos(1, -10, -37);
  const perto = pos(2, -10, -37 + 0.00017);
  const longe = pos(3, -10, -37 - 0.00019);
  assert.ok(haversine(base, perto) < 20);
  assert.ok(haversine(base, longe) >= 20);
  const ids = rodar([base, perto, longe], 'adaptive').map((e) => e.monitoradosEncontro.join('-'));
  assert.deepEqual(ids, ['1-2']);
});

test('classificação: facção, genérico e protetiva; vítimas entre si e sem vínculo não geram encontro', () => {
  const grupo = [
    pos(1, -10, -37, { faccao: '5' }), pos(2, -10, -37, { faccao: '5' }), pos(3, -10, -37), pos(4, -10, -37),
    pos(10, -10, -37, { vitima: true, restricoes: [1] }), pos(11, -10, -37, { vitima: true, restricoes: [] }),
  ];
  const tipos = new Map(rodar(grupo, 'adaptive').map((e) => [e.monitoradosEncontro.join('-'), e.tipo]));
  assert.equal(tipos.get('1-2'), 'faccao');
  assert.equal(tipos.get('3-4'), 'generico');
  assert.equal(tipos.get('1-3'), 'generico');
  assert.equal(tipos.get('1-10'), 'protetiva');
  assert.equal(tipos.has('2-10'), false);
  assert.equal(tipos.has('10-11'), false);
  assert.equal(tipos.size, 7);
});

test('timestamps diferentes não são comparados', () => {
  assert.throws(() => rodar([pos(1, 0, 0), pos(2, 0, 0, { timestamp: '2024-01-01 00:00:05' })], 'adaptive'));
});

test('estratégias adaptativa e grade equivalem à força bruta em grupos densos aleatórios', () => {
  let seed = 987;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let rodada = 0; rodada < 300; rodada++) {
    const n = 5 + Math.floor(rnd() * 60);
    const grupo: Posicao[] = [];
    for (let i = 1; i <= n; i++) {
      // Região de ~100 m para forçar muitos pares próximos, inclusive perto da fronteira de 20 m.
      const lat = -10 + rnd() * 0.001, lon = -37 + rnd() * 0.001;
      if (rnd() < 0.15) grupo.push(pos(i, lat, lon, { vitima: true, restricoes: [1 + Math.floor(rnd() * n)].filter((r) => r !== i) }));
      else grupo.push(pos(i, lat, lon, { faccao: rnd() < 0.5 ? String(Math.floor(rnd() * 3)) : null }));
    }
    // Restrições só podem apontar para não vítimas, como exige a validação de entrada.
    for (const p of grupo) if (p.vitima) p.restricoes = p.restricoes.filter((r) => !grupo[r - 1]!.vitima);
    const ref = rodar(grupo, 'brute').sort((a, b) => chave(a).localeCompare(chave(b)));
    for (const [estrategia, limiar] of [['adaptive', undefined], ['grid', undefined], ['adaptive', 0]] as const) {
      const obtido = rodar(grupo, estrategia, limiar).sort((a, b) => chave(a).localeCompare(chave(b)));
      assert.deepEqual(obtido.map(chave), ref.map(chave), `${estrategia} divergiu na rodada ${rodada}`);
      obtido.forEach((e, i) => assert.equal(e.distanciaMetros, ref[i]!.distanciaMetros));
    }
  }
});

test('varredura em latitude emite na mesma ordem do laço par a par', () => {
  const grupo = [pos(1, -10, -37), pos(2, -10.00005, -37), pos(3, -9.99995, -37), pos(4, -10.00002, -37)];
  const ordem = rodar(grupo, 'adaptive').map((e) => e.monitoradosEncontro.join('-'));
  const esperado: string[] = [];
  for (let i = 0; i < grupo.length; i++) for (let j = i + 1; j < grupo.length; j++) {
    if (haversine(grupo[i]!, grupo[j]!) < 20) esperado.push([grupo[i]!.id, grupo[j]!.id].sort((a, b) => a - b).join('-'));
  }
  assert.deepEqual(ordem, esperado);
});

test('polos e antimeridiano: grade e força bruta concordam', () => {
  const grupo = [pos(1, 89.99999, 10), pos(2, 89.99999, -170), pos(3, 0, 179.99999), pos(4, 0, -179.99999), pos(5, -90, 0)];
  const a = rodar(grupo, 'grid').map(chave).sort();
  const b = rodar(grupo, 'brute').map(chave).sort();
  assert.deepEqual(a, b);
});
