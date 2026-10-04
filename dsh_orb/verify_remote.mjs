import { execFileSync } from 'node:child_process';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO || 'shenmidigua/dafeiyu-orb';
const H = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'wb' };
const B = `https://api.github.com/repos/${REPO}`;
const CWD = process.argv[2] || process.cwd();

const raw = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-tree', '-r', 'HEAD'],
  { cwd: CWD, maxBuffer: 1 << 30 }).toString('utf8');
const local = new Map();
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  const m = /^(\d{6}) \w+ ([0-9a-f]{40})\t(.+)$/.exec(line);
  if (m) local.set(m[3], m[2]);
}

const head = await (await fetch(`${B}/git/ref/heads/main`, { headers: H })).json();
const sha = head.object.sha;
console.log('remote main:', sha);

const j = await (await fetch(`${B}/git/trees/${sha}?recursive=1`, { headers: H })).json();
if (j.truncated) { console.log('WARNING: truncated — cannot verify'); process.exit(2); }
const remote = new Map();
for (const t of j.tree) if (t.type === 'blob') remote.set(t.path, t.sha);

const missing = [], differ = [];
for (const [p, s] of local) {
  if (!remote.has(p)) missing.push(p);
  else if (remote.get(p) !== s) differ.push(p);
}
const extra = [...remote.keys()].filter((p) => !local.has(p));

console.log('local files :', local.size);
console.log('remote files:', remote.size);
console.log('missing:', missing.length, '| sha mismatch:', differ.length, '| extra:', extra.length);
for (const p of missing.slice(0, 10)) console.log('   -', p);
for (const p of differ.slice(0, 10)) console.log('   !', p);
for (const p of extra.slice(0, 10)) console.log('   +', p);

const top = new Map();
for (const p of local.keys()) {
  const t = p.includes('/') ? p.split('/')[0] : '(root)';
  top.set(t, (top.get(t) || 0) + 1);
}
console.log('\nper top-level directory:');
for (const [d, n] of [...top].sort((a, b) => b[1] - a[1])) {
  const present = [...remote.keys()].filter((p) => (p.includes('/') ? p.split('/')[0] : '(root)') === d).length;
  console.log(`   ${present === n ? 'OK ' : '!! '}${d}: local ${n}, remote ${present}`);
}

const ok = missing.length === 0 && differ.length === 0 && extra.length === 0;
console.log('\n' + (ok ? 'VERIFIED: remote is byte-identical to local HEAD' : 'MISMATCH'));
process.exit(ok ? 0 : 1);