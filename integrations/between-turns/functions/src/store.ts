import { getFirestore } from 'firebase-admin/firestore';
export interface Transaction { get<T>(path: string): Promise<T | null>; set(path: string, value: unknown): void; delete(path: string): void; }
export interface Store { transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>; }

export class FirestoreStore implements Store {
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const db = getFirestore();
    return db.runTransaction(async native => {
      const writes = new Map<string, unknown>();
      const result = await fn({
        async get<T>(path: string) {
          if (writes.has(path)) return (writes.get(path) ?? null) as T | null;
          const snap = await native.get(db.doc(path));
          return snap.exists ? snap.data() as T : null;
        },
        set: (path, value) => { writes.set(path, value); },
        delete: path => { writes.set(path, null); },
      });
      // Buffer all mutations so Firestore reads always precede writes.
      for (const [path, value] of writes) {
        if (value === null) native.delete(db.doc(path));
        else native.set(db.doc(path), value as Record<string, unknown>);
      }
      return result;
    });
  }
}
