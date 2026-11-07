// A project .env is read with dotenv rules: an unquoted value ends before " #", and surrounding quotes are removed.
// mcp-doc-search's .env carried "SEARCH_EMBEDDING_MODEL=qwen3-embedding-8b   # comment", and the whole line, comment
// included, became the model id, so every default search_code call in that repository failed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { envManager } from '../utils/env-manager';

const repoWith = (env: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-envparse-'));
    fs.writeFileSync(path.join(dir, '.env'), env);
    return dir;
};
const read = (env: string, key: string) => {
    const dir = repoWith(env);
    return envManager.runWithProject(dir, async () => envManager.get(key));
};

describe('project .env parsing', () => {
    it('drops an inline comment after an unquoted value', async () => {
        await expect(read('SEARCH_EMBEDDING_MODEL=qwen3-embedding-8b   # search default only\n', 'SEARCH_EMBEDDING_MODEL'))
            .resolves.toBe('qwen3-embedding-8b');
    });
    it('keeps a # that is part of the value', async () => {
        await expect(read('URL=http://h/p#frag\n', 'URL')).resolves.toBe('http://h/p#frag');
    });
    it('removes surrounding double and single quotes, keeping a # inside them', async () => {
        await expect(read('A="x # y"  # note\n', 'A')).resolves.toBe('x # y');
        await expect(read("B='quoted'\n", 'B')).resolves.toBe('quoted');
    });
    it('handles CRLF line endings and an export prefix', async () => {
        await expect(read('export C=value\r\nD=two\r\n', 'C')).resolves.toBe('value');
        await expect(read('export C=value\r\nD=two\r\n', 'D')).resolves.toBe('two');
    });
    it('keeps an empty value empty', async () => {
        await expect(read('E=\n', 'E')).resolves.toBe('');
    });
});
