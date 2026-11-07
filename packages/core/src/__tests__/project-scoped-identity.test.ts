// One server syncs every repository in the shared snapshot, while its env block names one project. A repository that
// names its own 8B collection must never inherit that project's 0.6B collection: those rows would land in another repo.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Context } from '../context';
import { envManager } from '../utils/env-manager';

const MODEL_06 = 'qwen3-embedding-0.6b';
const embedding = (dim: number): any => ({ getProvider: () => 'fake', getDimension: () => dim, embed: async () => ({ vector: [], dimension: dim }) });
const repoWith = (env: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-identity-'));
    fs.writeFileSync(path.join(dir, '.env'), env);
    return dir;
};

describe('getCollectionNameForModel under a project scope', () => {
    const ctx = new Context({ embedding: embedding(4096), secondaryEmbedding: embedding(1024), vectorDatabase: {} as any });
    beforeEach(() => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
    });
    afterEach(() => {
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
    });
    const name = (dir: string) => envManager.runWithProject(dir, async () => ctx.getCollectionNameForModel(dir, MODEL_06));

    it('derives from the project collection when the project sets no 0.6B name', async () => {
        await expect(name(repoWith('MILVUS_COLLECTION_PRIVATE=gpu_coordinator_own\n'))).resolves.toBe('gpu_coordinator_own_0p6b');
    });

    it('keeps an explicit project 0.6B name', async () => {
        await expect(name(repoWith('MILVUS_COLLECTION_PRIVATE=a_own\nMILVUS_COLLECTION_PRIVATE_0P6B=a_custom\n'))).resolves.toBe('a_custom');
    });

    it('keeps the env block when the project names nothing', async () => {
        await expect(name(repoWith('OTHER=1\n'))).resolves.toBe('claude_context_own_0p6b');
    });
});
