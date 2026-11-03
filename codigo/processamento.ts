import { lstat, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Posicao } from './dominio/tipos.js';
import { criarMetricasDeteccao, LIMIAR_BUSCA_DIRETA, detectarEncontros, type Estrategia, type MetricasDeteccao } from './deteccao/motor.js';
import { lerLotesPosicoes } from './arquivos/leitura.js';
import { agruparLotesPosicoes, ErroOrdemTemporal } from './arquivos/agrupamento.js';
import { ordenarExternamente } from './arquivos/ordenacao-externa.js';
import { EscritorJson } from './arquivos/escrita.js';

export interface OpcoesProcessamento {
  strategy?: Estrategia; threshold?: number; order?: 'auto' | 'sorted' | 'external';
  chunkRecords?: number; maxGroupRecords?: number;
}
export interface MetricasProcessamento extends MetricasDeteccao {
  input: string; output: string; strategy: Estrategia; threshold: number; sortedExternally: boolean;
  inputRecords: number; uniqueRecords: number; duplicates: number; groups: number;
  elapsedMs: number; readMs: number; processMs: number; writeMs: number; retryMs: number;
  recordsPerSecond: number; rssPeakBytes: number; heapPeakBytes: number; processLifetimeMaxRssBytes: number;
}

async function validarCaminhos(input: string, output: string): Promise<{ input: string; output: string }> {
  const source = await realpath(resolve(input));
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) throw new Error('Entrada deve ser arquivo regular.');
  await mkdir(dirname(resolve(output)), { recursive: true });
  const target = join(await realpath(dirname(resolve(output))), basename(resolve(output)));
  const normalize = (p: string): string => process.platform === 'win32' ? p.toLowerCase() : p;
  if (normalize(source) === normalize(target)) throw new Error('Saída não pode sobrescrever a entrada.');
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error('Saída existente deve ser arquivo regular, sem link simbólico.');
    if (targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino) throw new Error('Saída não pode ser um alias da entrada.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { input: source, output: target };
}

export async function processarArquivo(input: string, output: string, options: OpcoesProcessamento = {}): Promise<MetricasProcessamento> {
  const started = performance.now();
  const resolved = await validarCaminhos(input, output);
  const strategy = options.strategy ?? 'adaptive', threshold = options.threshold ?? LIMIAR_BUSCA_DIRETA;
  const order = options.order ?? 'auto', maxGroup = options.maxGroupRecords ?? 250_000;
  if (!['brute', 'grid', 'adaptive'].includes(strategy) || !['auto', 'sorted', 'external'].includes(order)) throw new Error('Estratégia ou ordenação inválida.');
  for (const n of [threshold, maxGroup, options.chunkRecords ?? 50_000]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('Limites devem ser inteiros positivos.');
  let external = order === 'external', retryMs = 0;
  for (;;) {
    const metrics: MetricasProcessamento = { ...criarMetricasDeteccao(), ...resolved, strategy, threshold, sortedExternally: external,
      inputRecords: 0, uniqueRecords: 0, duplicates: 0, groups: 0,
      elapsedMs: 0, readMs: 0, processMs: 0, writeMs: 0, retryMs,
      recordsPerSecond: 0, rssPeakBytes: 0, heapPeakBytes: 0, processLifetimeMaxRssBytes: 0 };
    const amostrarMemoria = (): void => {
      const memory = process.memoryUsage();
      metrics.rssPeakBytes = Math.max(metrics.rssPeakBytes, memory.rss);
      metrics.heapPeakBytes = Math.max(metrics.heapPeakBytes, memory.heapUsed);
    };
    const timer = setInterval(amostrarMemoria, 50); timer.unref(); amostrarMemoria();
    const writer = new EscritorJson(resolved.output);
    let temporary: string | undefined;
    let groups: AsyncGenerator<Posicao[]> | undefined;
    try {
      await writer.iniciar();
      if (external) temporary = await mkdtemp(join(dirname(resolved.output), '.spacecom-'));
      async function* lerLotesOrdenados(): AsyncGenerator<Posicao[]> {
        let lote: Posicao[] = [];
        for await (const posicao of ordenarExternamente(resolved.input, temporary!, options.chunkRecords ?? 50_000)) {
          lote.push(posicao);
          if (lote.length >= 1024) { yield lote; lote = []; }
        }
        if (lote.length > 0) yield lote;
      }
      const source = external ? lerLotesOrdenados() : lerLotesPosicoes(resolved.input);
      async function* counted(): AsyncGenerator<Posicao[]> {
        for await (const lote of source) { metrics.inputRecords += lote.length; yield lote; }
      }
      groups = agruparLotesPosicoes(counted(), maxGroup);
      for (;;) {
        const readStart = performance.now();
        const group = await groups.next();
        metrics.readMs += performance.now() - readStart;
        if (group.done) break;
        metrics.groups++; metrics.uniqueRecords += group.value.length;
        let processingStart = performance.now();
        for (const encounter of detectarEncontros(group.value, strategy, metrics, threshold)) {
          if (writer.adicionar(encounter)) {
            metrics.processMs += performance.now() - processingStart;
            const writeStart = performance.now(); await writer.descarregar(); metrics.writeMs += performance.now() - writeStart;
            processingStart = performance.now();
          }
        }
        metrics.processMs += performance.now() - processingStart;
        if (metrics.groups % 128 === 0) amostrarMemoria();
      }
      const writeStart = performance.now(); await writer.concluir(); metrics.writeMs += performance.now() - writeStart;
      metrics.duplicates = metrics.inputRecords - metrics.uniqueRecords;
      metrics.elapsedMs = performance.now() - started;
      metrics.recordsPerSecond = metrics.inputRecords / (metrics.elapsedMs / 1000);
      amostrarMemoria(); metrics.processLifetimeMaxRssBytes = process.resourceUsage().maxRSS * 1024;
      return metrics;
    } catch (error) {
      await groups?.return(undefined);
      await writer.abortar();
      if (error instanceof ErroOrdemTemporal && order === 'auto' && !external) {
        external = true; retryMs = performance.now() - started;
      } else throw error;
    } finally {
      clearInterval(timer);
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
}
