// Edit G — MilvusVectorDatabase no longer discards the MutationResult.
// A non-`Success` insert/insertHybrid result must surface as a thrown error so
// the indexer (Commit 2) can classify it; a `Success` result is a no-op.
//
// This test lives under embedding/__tests__ to match the Commit-1 add-set, but
// it exercises the vectordb module. We stub the SDK so the constructor does not
// open a real gRPC connection (same pattern as vectordb/__tests__/query-all.test.ts).
jest.mock('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: class {},
  DataType: {},
  MetricType: {},
  FunctionType: {},
  LoadState: { LoadStateLoaded: 'LoadStateLoaded' },
}));

import { MilvusVectorDatabase } from '../../vectordb/milvus-vectordb';

function makeDb(insertImpl: (req: any) => Promise<any>): MilvusVectorDatabase {
  const db = new MilvusVectorDatabase({ address: 'unused' });
  // Neutralize the background initializeClient() so it cannot overwrite our mock.
  (db as any).initializeClient = async () => {};
  (db as any).ensureInitialized = async () => {};
  (db as any).ensureLoaded = async () => {};
  (db as any).client = { insert: insertImpl };
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
  metadata: {},
}];

describe('Edit G — insert surfaces MutationResult failures', () => {
  it('insert throws when the mutation result is not Success', async () => {
    const db = makeDb(async () => ({ status: { error_code: 'CollectionNotExists', reason: 'no such collection' } }));
    await expect(db.insert('c1', docs as any)).rejects.toThrow(/insert failed for 'c1'/);
  });

  it('insert resolves on a Success result', async () => {
    const db = makeDb(async () => ({ status: { error_code: 'Success', reason: '' } }));
    await expect(db.insert('c1', docs as any)).resolves.toBeUndefined();
  });

  it('insert resolves when no status is returned (legacy/permissive)', async () => {
    const db = makeDb(async () => ({}));
    await expect(db.insert('c1', docs as any)).resolves.toBeUndefined();
  });

  it('insertHybrid throws when the mutation result is not Success', async () => {
    const db = makeDb(async () => ({ status: { error_code: 'OutOfMemory', reason: 'oom' } }));
    await expect(db.insertHybrid('c1', docs as any)).rejects.toThrow(/insert failed for 'c1'/);
  });

  it('insertHybrid resolves on a Success result', async () => {
    const db = makeDb(async () => ({ status: { error_code: 'Success' } }));
    await expect(db.insertHybrid('c1', docs as any)).resolves.toBeUndefined();
  });
});
