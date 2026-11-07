// A server's env block names one project. Syncing another repository that has no identity of its own would write that
// repository into the block's collections, so the background sync leaves such a repository alone.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { belongsToEnvBlockOfAnotherProject } from "./sync.js";

const repoWith = (env?: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sync-identity-"));
    if (env) fs.writeFileSync(path.join(dir, ".env"), env);
    return dir;
};

describe("belongsToEnvBlockOfAnotherProject", () => {
    beforeEach(() => { process.env.MILVUS_COLLECTION_PRIVATE = "claude_context_own"; });
    afterEach(() => { delete process.env.MILVUS_COLLECTION_PRIVATE; });

    it("flags a repository with no identity while the env block names a project", async () => {
        assert.equal(await belongsToEnvBlockOfAnotherProject(repoWith("OTHER=1\n")), true);
    });

    it("passes a repository that names its own collection", async () => {
        assert.equal(await belongsToEnvBlockOfAnotherProject(repoWith("MILVUS_COLLECTION_PRIVATE=a_own\n")), false);
    });

    it("passes the project the server was started in", async () => {
        assert.equal(await belongsToEnvBlockOfAnotherProject(process.cwd()), false);
    });

    it("passes everything when the env block names no project", async () => {
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        assert.equal(await belongsToEnvBlockOfAnotherProject(repoWith()), false);
    });
});
