// O horário civil é preservado como texto para evitar conversões implícitas de fuso.
export interface Posicao {
  id: number;
  faccao: string | null;
  timestamp: string;
  lat: number;
  lon: number;
  vitima: boolean;
  restricoes: number[];
}

export type TipoEncontro = 'generico' | 'faccao' | 'protetiva';

export interface Encontro {
  tipo: TipoEncontro;
  monitoradosEncontro: [number, number];
  timestamp: string;
  posicoes: Record<string, { lat: number; lon: number }>;
  distanciaMetros: number;
}
