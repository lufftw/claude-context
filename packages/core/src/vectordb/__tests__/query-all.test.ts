// Stub the SDK so the constructor's `new MilvusClient(...)` does NOT open a real
// gRPC connection to the dummy address (which otherwise throws an unhandled
// "Name resolution failed" rejection that crashes the jest worker). The test
// overrides `client` / `ensureInitialized` / `ensureLoaded` directly, so the
// stubbed client is never used for the assertions.
jest.mock('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: class {},
  DataType: {},
  MetricType: {},
  FunctionType: {},
  LoadState: { LoadStateLoaded: 'LoadStateLoaded' },
}));

import { MilvusVectorDatabase } from '../milvus-vectordb';

describe('MilvusVectorDatabase.queryAll', () => {
  it('drains all batches via async-iterator without double-counting the final batch', async () => {
    const db = new MilvusVectorDatabase({ address: 'unused' });
    // The constructor kicks off async initialize() -> initializeClient(), which would
    // overwrite our injected mock `client` with a real (stubbed) MilvusClient on a
    // later microtask. Neutralize that background path; it runs after this sync body
    // sets the override but before our awaited call reads `this.client`.
    (db as any).initializeClient = async () => {};
    const batches = [
      [{ relativePath: 'a', id: '1' }, { relativePath: 'b', id: '2' }],
      [{ relativePath: 'c', id: '3' }],
    ];
    let capturedFields: string[] = [];
    (db as any).client = {
      queryIterator: async (req: any) => {
        capturedFields = req.output_fields;
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i < batches.length) return { done: false, value: batches[i++] };
                return { done: true, value: batches[batches.length - 1] }; // SDK re-emits last batch
              },
            };
          },
        };
      },
    };
    (db as any).ensureInitialized = async () => {};
    (db as any).ensureLoaded = async () => {};

    const rows = await db.queryAll('c1', ['relativePath']);
    expect(rows.map(r => r.relativePath)).toEqual(['a', 'b', 'c']); // no duplicate 'c'
    expect(capturedFields).toContain('id'); // PK injected so pagination advances
  });
});
