import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { processarArquivo, type OpcoesProcessamento } from './processamento.js';
import { LIMIAR_BUSCA_DIRETA, type Estrategia } from './deteccao/motor.js';

const AJUDA = `Spacecom — detecção de encontros

node compilado/codigo/terminal.js --entrada arquivo.txt --saida encontros.json
node compilado/codigo/terminal.js --arquivo 1 [--pasta-entradas entradas] [--pasta-saidas saidas]
node compilado/codigo/terminal.js --todos [--pasta-entradas entradas] [--pasta-saidas saidas]

Opções:
  --estrategia forca-bruta|grade|adaptativa  Estratégia (padrão: adaptativa)
  --limiar N                      Até N monitorados: busca direta (padrão: ${LIMIAR_BUSCA_DIRETA})
  --ordem automatica|ordenada|externa  Como tratar registros fora de ordem
  --registros-por-lote N           Limite por lote externo (padrão: 50000)
  --maximo-por-grupo N             Limite por instante (padrão: 250000)
  --ajuda                         Exibe ajuda

Padrões: entradas/, saidas/, encontrosN.json. --todos processa arquivos 1 a 7 presentes
e informa ausentes. Métricas JSON em stderr; arquivos de saída contêm só encontros.
Saída: 0 sucesso, 1 erro de processamento, 2 uso inválido.
`;

const PARAMETROS: Record<string, string> = {
  '--entrada': '--input', '--saida': '--output', '--arquivo': '--dataset', '--todos': '--all',
  '--pasta-entradas': '--data-dir', '--pasta-saidas': '--output-dir', '--estrategia': '--strategy',
  '--limiar': '--threshold', '--ordem': '--order', '--registros-por-lote': '--chunk-records',
  '--maximo-por-grupo': '--max-group-records', '--ajuda': '--help',
};

class UsageError extends Error {}
function positive(value: string, name: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) throw new UsageError(`${name} requer inteiro positivo.`);
  return n;
}

async function executar(): Promise<void> {
  // A normalização preserva os comandos antigos e mantém um único caminho de validação.
  const args = process.argv.slice(2).map(valor => Object.hasOwn(PARAMETROS, valor) ? PARAMETROS[valor]! : valor);
  if (!args.length || args.includes('--help')) { process.stdout.write(AJUDA); return; }
  const allowed = new Set(['--input','--output','--dataset','--data-dir','--output-dir','--strategy','--threshold','--order','--chunk-records','--max-group-records']);
  const values = new Map<string,string>();
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--all' && !all) { all = true; continue; }
    if (!allowed.has(flag) || values.has(flag)) throw new UsageError(`Parâmetro inválido ou repetido: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new UsageError(`Valor ausente para ${flag}.`);
    values.set(flag, value);
  }
  const input = values.get('--input'), output = values.get('--output'), dataset = values.get('--dataset');
  if (Number(all) + Number(input !== undefined) + Number(dataset !== undefined) !== 1) throw new UsageError('Escolha exatamente um: --input, --dataset ou --all.');
  if (input && !output) throw new UsageError('--input requer --output.');
  if (all && output) throw new UsageError('--all usa --output-dir.');
  if (input && (values.has('--data-dir') || values.has('--output-dir'))) throw new UsageError('--input usa --output; diretórios são exclusivos do modo dataset.');
  const options: OpcoesProcessamento = {};
  const estrategiaInformada = values.get('--strategy');
  const estrategias: Record<string, string> = { 'forca-bruta': 'brute', grade: 'grid', adaptativa: 'adaptive' };
  const strategy = estrategiaInformada && Object.hasOwn(estrategias, estrategiaInformada) ? estrategias[estrategiaInformada]! : estrategiaInformada;
  if (strategy) {
    if (!['brute','grid','adaptive'].includes(strategy)) throw new UsageError('Estratégia inválida.');
    options.strategy = strategy as Estrategia;
  }
  const ordemInformada = values.get('--order');
  const ordens: Record<string, string> = { automatica: 'auto', ordenada: 'sorted', externa: 'external' };
  const order = ordemInformada && Object.hasOwn(ordens, ordemInformada) ? ordens[ordemInformada]! : ordemInformada;
  if (order) {
    if (!['auto','sorted','external'].includes(order)) throw new UsageError('Ordenação inválida.');
    options.order = order as 'auto'|'sorted'|'external';
  }
  if (values.has('--threshold')) options.threshold = positive(values.get('--threshold')!, '--threshold');
  if (values.has('--chunk-records')) options.chunkRecords = positive(values.get('--chunk-records')!, '--chunk-records');
  if (values.has('--max-group-records')) options.maxGroupRecords = positive(values.get('--max-group-records')!, '--max-group-records');
  const jobs: { input: string; output: string }[] = [];
  if (input) jobs.push({ input, output: output! });
  else {
    const ids = all ? [1,2,3,4,5,6,7] : [positive(dataset!, '--dataset')];
    if (ids.some(n => n > 7)) throw new UsageError('Dataset deve ser 1 a 7.');
    for (const id of ids) {
      const path = resolve(values.get('--data-dir') ?? 'entradas', `dataset${id}.txt`);
      try { await access(path); } catch (error) {
        if (all && (error as NodeJS.ErrnoException).code === 'ENOENT') { process.stderr.write(`Dataset ${id} ausente; ignorado.\n`); continue; }
        throw error;
      }
      jobs.push({ input: path, output: output ?? resolve(values.get('--output-dir') ?? 'saidas', `encontros${id}.json`) });
    }
  }
  if (!jobs.length) throw new Error('Nenhum dataset disponível.');
  for (const job of jobs) process.stderr.write(JSON.stringify(await processarArquivo(job.input, job.output, options)) + '\n');
}

executar().catch((error: unknown) => {
  process.exitCode = error instanceof UsageError ? 2 : 1;
  const code = (error as NodeJS.ErrnoException).code;
  // Mensagens de falhas de SO não repetem caminhos possivelmente sensíveis.
  const message = code ? `Falha de arquivo/sistema (${code}).` : error instanceof Error ? error.message : 'Falha inesperada.';
  process.stderr.write(`Erro: ${message}\n`);
});
