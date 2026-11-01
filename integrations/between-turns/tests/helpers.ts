import type { Store, Transaction } from '../functions/src/store';
export class MemoryStore implements Store {
  data = new Map<string, unknown>();
  private queue = Promise.resolve();
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const copy = structuredClone(this.data);
      const result = await fn({ get: async <U>(path: string) => structuredClone(copy.get(path) ?? null) as U | null, set: (path, value) => { copy.set(path, structuredClone(value)); }, delete: path => { copy.delete(path); } });
      this.data = copy; return structuredClone(result);
    });
    this.queue = run.then(() => {}, () => {}); return run;
  }
}
