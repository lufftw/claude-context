import { MilvusVectorDatabase } from './milvus-vectordb';

/** checkCollectionLimit() creates a throwaway collection to probe the limit. */
function dbWithClient(createCollection: () => Promise<unknown>): MilvusVectorDatabase {
    const db = Object.create(MilvusVectorDatabase.prototype) as any;
    db.client = {
        createCollection,
        hasCollection: async () => ({ value: false }),
        dropCollection: async () => ({}),
    };
    return db as MilvusVectorDatabase;
}

describe('MilvusVectorDatabase.checkCollectionLimit', () => {
    it('does not probe a self-hosted server: a role that may create but not drop would leak the probe', async () => {
        let created = 0;
        const db: any = dbWithClient(async () => { created++; return {}; });
        db.config = { address: '192.168.0.55:19530' };
        await expect(db.checkCollectionLimit()).resolves.toBe(true);
        expect(created).toBe(0);
    });

    it('still probes Zilliz Cloud, where the limit is a plan limit', async () => {
        let created = 0;
        const db: any = dbWithClient(async () => { created++; return {}; });
        db.config = { address: 'https://in03-abc.api.gcp-us-west1.zillizcloud.com' };
        await expect(db.checkCollectionLimit()).resolves.toBe(true);
        expect(created).toBe(1);
    });

    it('returns true when the dummy collection is created', async () => {
        const db = dbWithClient(async () => ({}));
        await expect(db.checkCollectionLimit()).resolves.toBe(true);
    });

    it('returns false when the collection limit is exceeded', async () => {
        const db = dbWithClient(async () => {
            throw new Error('exceeded the limit number of collections');
        });
        await expect(db.checkCollectionLimit()).resolves.toBe(false);
    });

    it('proceeds (true) when the user may not create collections', async () => {
        const db = dbWithClient(async () => {
            throw new Error('7 PERMISSION_DENIED: PrivilegeCreateCollection: permission deny to devtools in the `default` database');
        });
        await expect(db.checkCollectionLimit()).resolves.toBe(true);
    });

    it('still throws on unrelated errors', async () => {
        const db = dbWithClient(async () => {
            throw new Error('connection reset');
        });
        await expect(db.checkCollectionLimit()).rejects.toThrow('connection reset');
    });
});
