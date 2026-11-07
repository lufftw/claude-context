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

// The search handler asks isModelReadable before it searches, outside any project scope. Without its own scope the check
// looked for the env block's 0.6B collection, or for a hash-named one when the block named none, so a repository whose
// own .env names its 0.6B collection was refused even with full coverage.
describe('isModelReadable resolves the repository\'s own collection', () => {
    afterEach(() => {
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
    });
    const probe = () => {
        const asked: string[] = [];
        const ctx = new Context({
            embedding: embedding(4096), secondaryEmbedding: embedding(1024),
            vectorDatabase: { hasCollection: async (n: string) => { asked.push(n); return n === 'repo_own_0p6b'; } } as any,
            coverageReader: () => 1,
        });
        return { ctx, asked };
    };

    it('checks the project collection when the env block names none', async () => {
        const { ctx, asked } = probe();
        const dir = repoWith('MILVUS_COLLECTION_PRIVATE=repo_own\nMILVUS_COLLECTION_PRIVATE_0P6B=repo_own_0p6b\n');
        await expect(ctx.isModelReadable(dir, MODEL_06)).resolves.toBe(true);
        expect(asked).toEqual(['repo_own_0p6b']);
    });

    it('checks the project collection, not the env block\'s, when both name one', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
        const { ctx, asked } = probe();
        await expect(ctx.isModelReadable(repoWith('MILVUS_COLLECTION_PRIVATE=repo_own\n'), MODEL_06)).resolves.toBe(true);
        expect(asked).toEqual(['repo_own_0p6b']);
    });
});
