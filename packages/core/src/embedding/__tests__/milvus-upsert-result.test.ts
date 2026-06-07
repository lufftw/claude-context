// Phase 3 — native upsert for idempotent chunk writes.
// upsert/upsertHybrid must (a) call client.upsert with the mapped data,
// (b) THROW on a non-`Success` MutationResult (Commit 1's result-check, preserved),
// (c) resolve on a `Success` result or a result with no status (legacy/permissive).
//
// This mirrors milvus-insert-result.test.ts. We stub the SDK so the constructor does
// not open a real gRPC connection (same pattern as vectordb/__tests__/query-all.test.ts).
jest.mock('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: class {},
  DataType: {},
  MetricType: {},
  FunctionType: {},
  LoadState: { LoadStateLoaded: 'LoadStateLoaded' },
}));

import { MilvusVectorDatabase } from '../../vectordb/milvus-vectordb';

function makeDb(upsertImpl: (req: any) => Promise<any>): MilvusVectorDatabase {
  const db = new MilvusVectorDatabase({ address: 'unused' });
  // Neutralize the background initializeClient() so it cannot overwrite our mock.
  (db as any).initializeClient = async () => {};
  (db as any).ensureInitialized = async () => {};
  (db as any).ensureLoaded = async () => {};
  (db as any).client = { upsert: upsertImpl };
  return db;
}

const docs = [{
  id: '1',
  vector: [0.1, 0.2],
  content: 'x',
  relativePath: 'a.ts',
  startLine: 1,
  endLine: 2,
  fileExtension: '.ts',
  metadata: { language: 'typescript' },
}];

describe('Phase 3 — upsert calls client.upsert with mapped data', () => {
  it('upsert calls client.upsert with collection_name + mapped data (metadata JSON-stringified)', async () => {
    const calls: any[] = [];
    const db = makeDb(async (req: any) => { calls.push(req); return { status: { error_code: 'Success' } }; });
    await db.upsert('c1', docs as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].collection_name).toBe('c1');
    expect(calls[0].data).toEqual([{
      id: '1',
      vector: [0.1, 0.2],
      content: 'x',
      relativePath: 'a.ts',
      startLine: 1,
      endLine: 2,
      fileExtension: '.ts',
      metadata: JSON.stringify({ language: 'typescript' }),
    }]);
  });

  it('upsertHybrid calls client.upsert with collection_name + mapped data', async () => {
    const calls: any[] = [];
    const db = makeDb(async (req: any) => { calls.push(req); return { status: { error_code: 'Success' } }; });
    await db.upsertHybrid('c1', docs as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].collection_name).toBe('c1');
    expect(calls[0].data[0].id).toBe('1');
    expect(calls[0].data[0].metadata).toBe(JSON.stringify({ language: 'typescript' }));
  });
});

describe('Phase 3 — upsert surfaces MutationResult failures', () => {
  it('upsert throws when the mutation result is not Success', async () => {
    const db = makeDb(async () => ({ status: { error_code: 'CollectionNotExists', reason: 'no such collection' } }));
    await expect(db.upsert('c1', docs as any)).rejects.toThrow(/upsert failed for 'c1'/);
  });

  it('upsert resolves on a Success result', async () => {
    const db = makeDb(async () => ({ status: { error_code: 'Success', reason: '' } }));
    await expect(db.upsert('c1', docs as any)).resolves.toBeUndefined();
  });

  it('upsert resolves when no status is returned (legacy/permissive)', async () => {
    const db = makeDb(async () => ({}));
    await expect(db.upsert('c1', docs as any)).resolves.toBeUndefined();
  });

  it('upsertHybrid throws when the mutation result is not Success', async () => {
    const db = makeDb(async () => ({ status: { error_code: 'OutOfMemory', reason: 'oom' } }));
    await expect(db.upsertHybrid('c1', docs as any)).rejects.toThrow(/upsert failed for 'c1'/);
  });

  it('upsertHybrid resolves on a Success result', async () => {
    const db = makeDb(async () => ({ status: { error_code: 'Success' } }));
    await expect(db.upsertHybrid('c1', docs as any)).resolves.toBeUndefined();
  });
});
