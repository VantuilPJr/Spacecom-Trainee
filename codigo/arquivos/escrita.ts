import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Encontro } from '../dominio/tipos.js';

export class EscritorJson {
  private file: FileHandle | undefined;
  private buffer = '[\n';
  private count = 0;
  private readonly temporary: string;
  constructor(private readonly output: string) { this.temporary = `${output}.${randomUUID()}.partial`; }
  async iniciar(): Promise<void> { this.file = await open(this.temporary, 'wx', 0o600); }
  adicionar(encounter: Encontro): boolean {
    this.buffer += (this.count++ ? ',\n' : '') + JSON.stringify(encounter);
    return this.buffer.length >= 256 * 1024;
  }
  async descarregar(): Promise<void> {
    if (!this.file) throw new Error('Escritor não iniciado.');
    if (this.buffer) { await this.file.writeFile(this.buffer); this.buffer = ''; }
  }
  async concluir(): Promise<void> {
    this.buffer += '\n]\n';
    await this.descarregar();
    await this.file!.sync();
    await this.file!.close(); this.file = undefined;
    // Publicar no mesmo diretório evita expor um JSON parcial como resultado final.
    await rename(this.temporary, this.output);
  }
  async abortar(): Promise<void> {
    await this.file?.close().catch(() => {}); this.file = undefined;
    await unlink(this.temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
