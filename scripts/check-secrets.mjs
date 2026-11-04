#!/usr/bin/env node
// Secret scanner for this repository (no dependencies).
//
//   node scripts/check-secrets.mjs            scan every tracked file (CI)
//   node scripts/check-secrets.mjs --staged   scan the staged version of staged files (pre-commit hook)
//   node scripts/check-secrets.mjs --history  audit every blob reachable from any ref (manual / after a purge)
//
// Flags credentials that must never be committed: inline AMQP/HTTP passwords, Milvus `user:password`
// tokens, well-known provider key formats, private keys, and literal fallbacks such as
// `process.env.MILVUS_TOKEN || 'root:…'`. Placeholders (your-…, xxx, dummy, fake, test, smoke, …) pass.
// Matched values are masked in the output so the report itself cannot leak them.
// A line can be exempted with a trailing `secret-scan: allow` comment (use sparingly, review required).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const staged = process.argv.includes('--staged');
const history = process.argv.includes('--history');

const PLACEHOLDER = /^(your[-_]|<|\$\{|\$[A-Z_]|%[A-Z_]|x{3,}|\*{3,})|xxx|fake|dummy|example|placeholder|changeme|change-me|redacted|do-not-use|noop|smoke|sample|mock|^test|^guest$|^password$|^secret$|^token$/i;
const isPlaceholder = (v) => v.length < 6 || PLACEHOLDER.test(v);

const RULES = [
    { name: 'URL with inline password', re: /\b(?:amqps?|https?|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s:/@'"`]+:([^\s@'"`]+)@/g },
    { name: 'user:password piped to base64 (Basic auth)', re: /['"`][A-Za-z0-9_.-]+:([^'"`\s]{6,})['"`]\s*\|\s*base64/g },
    { name: 'Milvus user:password token', re: /['"`](?:root|admin|milvus):([^'"`\s]{6,})['"`]/g },
    { name: 'credential env var with literal fallback', re: /(?:process\.env\.|env(?:Manager)?\.get\(\s*['"])[A-Z0-9_]*(?:TOKEN|API_KEY|APIKEY|PASSWORD|PASS|SECRET)\b['"]?\s*\)?\s*(?:\|\||\?\?)\s*['"`]([^'"`]+)['"`]/g },
    { name: 'OpenAI-style API key', re: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})\b/g },
    { name: 'Voyage API key', re: /\b(pa-[A-Za-z0-9_-]{40,})\b/g },
    { name: 'Google API key', re: /\b(AIza[0-9A-Za-z_-]{35})\b/g },
    { name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
    { name: 'AWS access key id', re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g },
    { name: 'Slack token', re: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g },
    { name: 'private key block', re: /(-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----)/g, always: true },
];

const SKIP = [/(^|\/)pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|vsix|woff2?|ttf|eot|mp4)$/i, /^scripts\/check-secrets\.mjs$/];

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// Each target is { label, read }: a path in the tree/index, or a historical blob with the first path it was seen at.
let targets;
if (history) {
    const seen = new Map(); // blob sha -> first path
    for (const row of git(['rev-list', '--objects', '--all']).split('\n')) {
        const sp = row.indexOf(' ');
        if (sp < 0) continue; // commits and the root tree have no path
        const sha = row.slice(0, sp);
        const path = row.slice(sp + 1);
        if (!seen.has(sha)) seen.set(sha, path);
    }
    const blobs = new Set(git(['cat-file', '--batch-check=%(objectname) %(objecttype)', '--batch-all-objects'])
        .split('\n').filter(l => l.endsWith(' blob')).map(l => l.split(' ')[0]));
    targets = [...seen].filter(([sha, path]) => blobs.has(sha) && !SKIP.some(re => re.test(path)))
        .map(([sha, path]) => ({ label: `${path}@${sha.slice(0, 10)}`, read: () => git(['cat-file', 'blob', sha]) }));
} else {
    targets = (staged
        ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
        : git(['ls-files', '-z'])
    ).split('\0').filter(f => f && !SKIP.some(re => re.test(f)))
        .map(f => ({ label: f, read: () => (staged ? git(['show', `:${f}`]) : readFileSync(f, 'utf8')) }));
}

const mask = (v) => (v.length <= 4 ? '****' : `${v.slice(0, 2)}${'*'.repeat(Math.min(v.length - 2, 12))}`);

const findings = [];
for (const { label, read } of targets) {
    let text;
    try {
        text = read();
    } catch {
        continue; // deleted / unreadable
    }
    if (text.includes('\0')) continue; // binary
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
        if (/secret-scan:\s*allow/.test(line)) return;
        for (const rule of RULES) {
            rule.re.lastIndex = 0;
            let m;
            while ((m = rule.re.exec(line)) !== null) {
                const value = m[1] ?? m[0];
                if (!rule.always && isPlaceholder(value)) continue;
                findings.push(`${label}:${i + 1}  ${rule.name}  (${mask(value)})`);
            }
        }
    });
}

if (findings.length > 0) {
    console.error(`✖ Possible secrets found (${findings.length}):`);
    for (const f of findings) console.error(`  ${f}`);
    console.error('\nRead credentials from the environment (e.g. MILVUS_TOKEN, RABBITMQ_INFERENCE_URL) with no literal fallback.');
    console.error('If a value is already pushed, rotate it: removing it from the tree does not remove it from git history.');
    if (history) console.error('History findings: see docs/security/credential-handling.md (rotation first, then an optional history purge).');
    process.exit(1);
}
console.log(`✓ No secrets found in ${targets.length} ${history ? 'historical blob(s)' : staged ? 'staged file(s)' : 'tracked file(s)'}.`);
