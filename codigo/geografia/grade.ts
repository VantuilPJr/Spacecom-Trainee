import { LIMITE_ENCONTRO_METROS, type PontoCartesiano } from './coordenadas.js';

// Um arco menor que 20 m implica corda menor que 20 m em cada eixo.
// Células ligeiramente maiores cobrem os candidatos nas 27 vizinhas.
// A margem de 1 micrômetro considera erros usuais de arredondamento no Node/V8.
// A hipótese numérica e seus limites estão descritos no README, na seção Grade espacial.
export const LADO_CELULA_METROS = LIMITE_ENCONTRO_METROS + 0.000001;

export class GradeEspacial<T> {
  private readonly buckets = new Map<string, T[]>();

  private localizarCelula(point: PontoCartesiano): [number, number, number] {
    return [
      Math.floor(point.x / LADO_CELULA_METROS),
      Math.floor(point.y / LADO_CELULA_METROS),
      Math.floor(point.z / LADO_CELULA_METROS),
    ];
  }

  inserir(point: PontoCartesiano, value: T): void {
    const [x, y, z] = this.localizarCelula(point);
    const key = `${x},${y},${z}`;
    const bucket = this.buckets.get(key);
    if (bucket === undefined) this.buckets.set(key, [value]);
    else bucket.push(value);
  }

  *buscarCandidatos(point: PontoCartesiano): Generator<T> {
    const [x, y, z] = this.localizarCelula(point);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.buckets.get(`${x + dx},${y + dy},${z + dz}`);
          if (bucket !== undefined) yield* bucket;
        }
      }
    }
  }
}
