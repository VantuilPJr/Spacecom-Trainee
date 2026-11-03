export const RAIO_TERRA_METROS = 6_371_000;
export const LIMITE_ENCONTRO_METROS = 20;
const GRAUS_PARA_RADIANOS = Math.PI / 180;

export interface PontoGeografico {
  lat: number;
  lon: number;
}

export interface PontoCartesiano {
  x: number;
  y: number;
  z: number;
}

// A decisão usa a distância completa. Arredondar aqui poderia aceitar ou rejeitar incorretamente um par junto ao limite.
export function haversine(a: PontoGeografico, b: PontoGeografico): number {
  const latA = a.lat * GRAUS_PARA_RADIANOS;
  const latB = b.lat * GRAUS_PARA_RADIANOS;
  const sinLat = Math.sin(((b.lat - a.lat) * GRAUS_PARA_RADIANOS) / 2);
  const sinLon = Math.sin(((b.lon - a.lon) * GRAUS_PARA_RADIANOS) / 2);
  const h = sinLat * sinLat + Math.cos(latA) * Math.cos(latB) * sinLon * sinLon;
  // O arredondamento próximo aos antípodas pode levar o intermediário para fora de [0, 1] e invalidar a raiz quadrada.
  const clamped = Math.max(0, Math.min(1, h));
  return RAIO_TERRA_METROS * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

// O mesmo raio da Haversine mantém a conversão cartesiana coerente com a regra de distância do case.
export function converterParaEcef(point: PontoGeografico): PontoCartesiano {
  const lat = point.lat * GRAUS_PARA_RADIANOS;
  const lon = point.lon * GRAUS_PARA_RADIANOS;
  const horizontalRadius = RAIO_TERRA_METROS * Math.cos(lat);
  return {
    x: horizontalRadius * Math.cos(lon),
    y: horizontalRadius * Math.sin(lon),
    z: RAIO_TERRA_METROS * Math.sin(lat),
  };
}
