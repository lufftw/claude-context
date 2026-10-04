import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// The synchronizer keeps its snapshots under os.homedir(); point the home directory at a temp dir
// before loading it so the tests never touch the real ~/.context.
const tempHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'cc-sync-home-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FileSynchronizer } = require('../synchronizer');

const OLD = new Date(Date.now() - 60_000); // outside the racy window

async function makeCodebase(files: Record<string, string>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-sync-root-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, 'utf-8');
        await fs.utimes(full, OLD, OLD);
    }
    return root;
}

function countHashReads(sync: any): { count: () => number } {
    let n = 0;
    const original = sync.hashFile.bind(sync);
    sync.hashFile = async (p: string) => { n++; return original(p); };
    return { count: () => n };
}

describe('FileSynchronizer change detection', () => {
    afterAll(() => fsSync.rmSync(tempHome, { recursive: true, force: true }));

    it('does not re-read unchanged files on a later check', async () => {
        const root = await makeCodebase({ 'a.ts': 'export const a = 1;', 'src/b.ts': 'export const b = 2;' });
        const sync = new FileSynchronizer(root, [], [], ['.ts']);
        await sync.initialize();
        const reads = countHashReads(sync);

        const changes = await sync.checkForChanges();

        expect(changes).toEqual({ added: [], removed: [], modified: [] });
        expect(reads.count()).toBe(0);
    });

    it('detects a modified file and re-reads only that file', async () => {
        const root = await makeCodebase({ 'a.ts': 'export const a = 1;', 'src/b.ts': 'export const b = 2;' });
        const sync = new FileSynchronizer(root, [], [], ['.ts']);
        await sync.initialize();
        await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 100;', 'utf-8');
        const reads = countHashReads(sync);

        const changes = await sync.checkForChanges();

        expect(changes.modified).toEqual(['a.ts']);
        expect(changes.added).toEqual([]);
        expect(changes.removed).toEqual([]);
        expect(reads.count()).toBe(1);
    });

    it('re-reads a file whose timestamp is too recent to trust, even with unchanged size and mtime', async () => {
        const root = await makeCodebase({ 'a.ts': 'export const a = 1;' });
        const now = new Date();
        await fs.utimes(path.join(root, 'a.ts'), now, now);
        const sync = new FileSynchronizer(root, [], [], ['.ts']);
        await sync.initialize();
        // Same length, same mtime, different content: only the racy guard can catch this.
        await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;', 'utf-8');
        await fs.utimes(path.join(root, 'a.ts'), now, now);

        const changes = await sync.checkForChanges();

        expect(changes.modified).toEqual(['a.ts']);
    });

    it('detects added and removed files', async () => {
        const root = await makeCodebase({ 'a.ts': 'export const a = 1;', 'gone.ts': 'export const g = 0;' });
        const sync = new FileSynchronizer(root, [], [], ['.ts']);
        await sync.initialize();
        await fs.rm(path.join(root, 'gone.ts'));
        await fs.writeFile(path.join(root, 'new.ts'), 'export const n = 3;', 'utf-8');

        const changes = await sync.checkForChanges();

        expect(changes.added).toEqual(['new.ts']);
        expect(changes.removed).toEqual(['gone.ts']);
        expect(changes.modified).toEqual([]);
    });

    it('persists file stats so a restarted synchronizer does not re-read unchanged files', async () => {
        const root = await makeCodebase({ 'a.ts': 'export const a = 1;', 'src/b.ts': 'export const b = 2;' });
        await new FileSynchronizer(root, [], [], ['.ts']).initialize();

        const restarted = new FileSynchronizer(root, [], [], ['.ts']);
        await restarted.initialize();
        const reads = countHashReads(restarted);
        const changes = await restarted.checkForChanges();

        expect(changes).toEqual({ added: [], removed: [], modified: [] });
        expect(reads.count()).toBe(0);
    });

    it('keeps applying ignore patterns across repeated checks', async () => {
        const root = await makeCodebase({
            'src/ok.ts': 'export const ok = 1;',
            'node_modules/pkg/index.ts': 'export const dep = 1;',
            'build/out.ts': 'export const built = 1;',
            'src/deep/generated.min.js': 'x',
            'notes.log': 'log',
        });
        const ignore = ['node_modules/**', 'build/', '*.min.js', '*.log'];
        const sync = new FileSynchronizer(root, ignore, [], ['.ts', '.js', '.log']);
        await sync.initialize();
        expect(Array.from((sync as any).fileHashes.keys())).toEqual([path.join('src', 'ok.ts')]);

        await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'other.ts'), 'export const d2 = 2;', 'utf-8');
        await fs.writeFile(path.join(root, 'src', 'deep', 'more.min.js'), 'y', 'utf-8');
        expect(await sync.checkForChanges()).toEqual({ added: [], removed: [], modified: [] });
    });

    it('loads a snapshot written before file stats existed, re-reading each file once', async () => {
        const root = await makeCodebase({ 'a.ts': 'export const a = 1;' });
        const first = new FileSynchronizer(root, [], [], ['.ts']);
        await first.initialize();
        // Rewrite the snapshot in the old format: no fileStats.
        const snapPath = (first as any).snapshotPath as string;
        const snap = JSON.parse(await fs.readFile(snapPath, 'utf-8'));
        delete snap.fileStats;
        await fs.writeFile(snapPath, JSON.stringify(snap), 'utf-8');

        const legacy = new FileSynchronizer(root, [], [], ['.ts']);
        await legacy.initialize();
        const reads = countHashReads(legacy);
        expect(await legacy.checkForChanges()).toEqual({ added: [], removed: [], modified: [] });
        expect(reads.count()).toBe(1);
        expect(await legacy.checkForChanges()).toEqual({ added: [], removed: [], modified: [] });
        expect(reads.count()).toBe(1);
    });
});
