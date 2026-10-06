// Publish the current local HEAD to GitHub through the GitHub API.
//
// Why not `git push`: on this machine github.com:443 is unreachable (push dies
// with "curl 55 Send failure"), while api.github.com and ssh.github.com both
// answer. Registering an SSH key is also out — the stored token's scopes are
// only `gist, repo, workflow`, and POST /user/keys without `admin:public_key`
// returns 404. So the API is the only route that works here.
//
//   GITHUB_TOKEN=ghp_xxx node dsh_orb/publish_to_github.mjs [repoDir]
//
// The token must come from the environment. GitHub's secret scanning rejects
// the blob otherwise ("Secret detected in content"), which is the right outcome —
// an access token has no business in a repository, least of all a public one.
//
// Two things that cost real time to learn, both now handled below:
//   - ls-tree octal-escapes non-ASCII paths unless core.quotepath=false, so
//     reading files by the printed path fails on the 215 CJK-named entries.
//   - GET /git/blobs/<sha> returns the whole base64 body, so probing for
//     existence re-downloads the entire repo. POST /git/trees instead: a 422
//     names the sha it could not resolve, which is a free existence check.
//   - `spawnSync git` can fail with EBUSY where the process is not allowed to
//     fork (sandboxes, some Windows setups). Pass DSH_TREE_FILE to read a
//     `git ls-tree -r HEAD` dump produced beforehand instead of shelling out:
//       git -c core.quotepath=false ls-tree -r HEAD > tree.txt
//       DSH_TREE_FILE=tree.txt node dsh_orb/publish_to_github.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO || 'shenmidigua/dafeiyu-orb';
if (!TOKEN) {
  console.error('GITHUB_TOKEN is not set. Get one from https://github.com/settings/tokens');
  console.error('Needs the `repo` scope. Do NOT hardcode it here — GitHub secret');
  console.error('scanning rejects any blob containing a token.');
  process.exit(1);
}
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'workbuddy',
};
const B = `https://api.github.com/repos/${REPO}`;
const CWD = process.argv[2] || process.cwd();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, init = {}, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 90000);
      const res = await fetch(B + path, { ...init, headers: H, signal: ctl.signal });
      clearTimeout(t);
      const txt = await res.text();
      if (!res.ok && (res.status >= 500 || res.status === 429)) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, json: txt ? JSON.parse(txt) : {} };
    } catch (e) {
      last = e;
      if (i === tries - 1) break;
      await sleep(Math.min(12000, 700 * 2 ** i));
    }
  }
  return { status: 0, json: { error: String(last) } };
}

// `core.quotepath=false` is not optional: without it ls-tree octal-escapes every
// non-ASCII path and the 215 CJK-named entries cannot be read back. DSH_TREE_FILE
// skips the subprocess entirely, so whoever produced the dump owns that flag.
const TREE_FILE = process.env.DSH_TREE_FILE;
const raw = TREE_FILE
  ? readFileSync(TREE_FILE, 'utf8')
  : execFileSync('git', ['-c', 'core.quotepath=false', 'ls-tree', '-r', 'HEAD'],
    { cwd: CWD, maxBuffer: 1 << 30 }).toString('utf8');
if (TREE_FILE) console.log(`tree from ${TREE_FILE} (no subprocess)`);
const files = [];
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  const m = /^(\d{6}) \w+ ([0-9a-f]{40})\t(.+)$/.exec(line);
  if (m) files.push({ mode: m[1], sha: m[2], path: m[3] });
}
const bySha = new Map(files.map((f) => [f.sha, f]));
console.log('local files:', files.length);

const dirs = new Map();
const addDir = (p) => { if (!dirs.has(p)) dirs.set(p, new Map()); return dirs.get(p); };
addDir('');
for (const f of files) {
  const parts = f.path.split('/');
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i];
    const childPath = cur ? `${cur}/${name}` : name;
    if (!addDir(cur).has(name)) {
      addDir(childPath);
      // Subdirectories are entries too, and GitHub wants a mode on every one.
      addDir(cur).set(name, { type: 'tree', mode: '040000', path: name });
    }
    cur = childPath;
  }
  addDir(cur).set(parts[parts.length - 1],
    { type: 'blob', mode: f.mode, sha: f.sha, path: parts[parts.length - 1] });
}

const made = new Map();
const uploaded = new Set();
const MISSING_RE = /tree\.sha ([0-9a-f]{40}) is not a valid/;

/**
 * Every blob in `DSH_BLOB_FILE`, keyed by sha.
 *
 * `git cat-file --batch` prints `<sha> blob <size>\n<bytes>\n` per record, so the
 * format is self-delimiting and a Buffer walk is enough — no length-prefixed
 * framing to trust. Empty when the variable is unset, and `loadBlob` then falls
 * back to one subprocess per file.
 */
function loadBlobBatch(file) {
  const buf = readFileSync(file);
  const map = new Map();
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl === -1) break;
    const header = buf.toString('latin1', at, nl);
    const parts = header.split(' ');
    if (parts.length < 3) break;
    const size = Number(parts[2]);
    if (!Number.isFinite(size)) break;
    const start = nl + 1;
    map.set(parts[0], buf.subarray(start, start + size));
    at = start + size + 1;
  }
  return map;
}

const batch = process.env.DSH_BLOB_FILE ? loadBlobBatch(process.env.DSH_BLOB_FILE) : null;
if (batch) console.log(`blob bodies from ${process.env.DSH_BLOB_FILE}: ${batch.size} blobs`);

// The one spawn that cannot be avoided from inside this process: reading blob
// bodies. It is a single `git cat-file --batch` for the whole repo rather than
// one `cat-file blob <sha>` per file, because the per-file form is what turns a
// fork restriction (EBUSY) into an unusable script.
//
// The bodies come from the object store, never from the working tree: five files
// in this repo differ between the two (CRLF on checkout), and reading those from
// disk would upload content whose sha is not the one the tree names.
function loadBlob(sha) {
  if (!batch) return execFileSync('git', ['cat-file', 'blob', sha], { cwd: CWD, maxBuffer: 1 << 30 });
  if (batch.has(sha)) return batch.get(sha);
  throw new Error(`${sha} is not in the batch dump; regenerate it after new commits`);
}

async function uploadBlob(sha) {
  if (uploaded.has(sha)) return true;
  const f = bySha.get(sha);
  if (!f) return false;
  const data = loadBlob(sha);
  for (let a = 0; a < 6; a++) {
    const r = await api('/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: data.toString('base64'), encoding: 'base64' }),
    }, 2);
    if (r.status === 201) {
      uploaded.add(sha);
      console.log(`  uploaded ${(data.length / 1048576).toFixed(2)} MiB  ${f.path}`);
      return true;
    }
    await sleep(1000 * (a + 1));
  }
  return false;
}

async function ensure(dir) {
  if (made.has(dir)) return made.get(dir);
  const children = [...dirs.get(dir).values()];
  for (const c of children) if (c.type === 'tree') c.sha = await ensure(dir ? `${dir}/${c.path}` : c.path);
  // A tree answers 422 naming exactly ONE unresolvable sha, so a directory with N new files needs
  // at least N rounds — and a first publish of dsh_orb/ had more new files than the old fixed
  // budget of 40, which failed the whole run after uploading most of them. The bound is derived
  // from the child count with room for the blobs the children's own subtrees still need to report.
  const rounds = 40 + children.length * 2;
  for (let round = 0; round < rounds; round++) {
    const r = await api('/git/trees', { method: 'POST', body: JSON.stringify({ tree: children }) });
    if (r.status === 201) { made.set(dir, r.json.sha); return r.json.sha; }
    const body = JSON.stringify(r.json);
    // "Your request timed out" on a large directory, with every blob already present. GitHub
    // rebuilds the whole subtree to answer, so a 274 MB asset directory can fail here no matter
    // how many times it is retried — and when that directory is unchanged since the last publish,
    // the previous commit already holds the exact sha this one wants. Point at it instead.
    if (/timed out/i.test(body) && reused.size > 0 && reused.get(dir) !== undefined) {
      const sha = reused.get(dir);
      console.log(`  ${dir || '<root>'}: timed out, reusing the sha the last commit already has`);
      made.set(dir, sha);
      return sha;
    }
    const m = MISSING_RE.exec(body);
    if (!m) {
      // A 5xx or a timeout is GitHub failing to rebuild the subtree, not a bad request: the same
      // body succeeds on a later attempt often enough to be worth waiting out. Only a 4xx that is
      // not the missing-sha 422 means the request itself is wrong.
      const transient = r.status >= 500 || r.status === 429 || /timed out|try again/i.test(body);
      if (transient && round < rounds - 1) {
        const wait = Math.min(2000 + round * 500, 15000);
        console.log(`  ${dir || '<root>'}: ${r.status} on tree, retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      console.error('tree failed:', dir || '<root>', r.status, body.slice(0, 400));
      process.exit(1);
    }
    console.log(`  missing blob ${m[1].slice(0, 10)}  ${bySha.get(m[1])?.path ?? '(unknown)'}`);
    if (!(await uploadBlob(m[1]))) { console.error('upload failed', m[1]); process.exit(1); }
  }
  console.error('tree did not converge:', dir);
  process.exit(1);
}

/**
 * Subtree shas the previous commit already holds, keyed by directory path.
 *
 * Read once, from the tree of the commit the new one will hang off, so `ensure()` can reuse a sha
 * for any directory whose contents did not change. Only consulted after a timeout — never
 * substituted for a build that succeeds — because a stale entry would silently publish the old
 * contents under the new message.
 */
const reused = new Map();
{
  const ref = await api('/git/ref/heads/main', {}, 3);
  const commitSha = ref.json?.object?.sha;
  if (commitSha) {
    const tree = await api(`/git/commits/${commitSha}`, {}, 3);
    const root = tree.json?.tree?.sha;
    if (root) {
      const flat = await api(`/git/trees/${root}?recursive=1`, {}, 3);
      // Reuse needs proof that nothing in the directory changed, and a sha comparison cannot
      // supply it: a blob whose contents were edited keeps its path, so a directory whose entry
      // list is identical may still need a new subtree. What does prove it is the previous commit —
      // see DSH_UNCHANGED_DIRS, which the caller derives from git itself.
      //
      // So this is only consulted for directories the caller vouched for, and the caller's claim is
      // checked here in one respect that costs nothing: the directory must exist remotely with the
      // same number of direct children. A wrong claim then fails loudly instead of publishing a
      // stale tree.
      const remoteChildren = new Map();
      for (const entry of flat.json?.tree ?? []) {
        if (entry.type !== 'tree') continue;
        const path = entry.path.split('/');
        const parent = path.slice(0, -1).join('/');
        if (!remoteChildren.has(parent)) remoteChildren.set(parent, []);
        remoteChildren.get(parent).push(entry.path.split('/').pop());
      }
      for (const dir of (process.env.DSH_UNCHANGED_DIRS ?? '').split(',').map((s) => s.trim())
        .filter(Boolean)) {
        const sha = flat.json?.tree?.find((e) => e.path === dir && e.type === 'tree')?.sha;
        const mine = dirs.has(dir) ? [...dirs.get(dir).keys()].sort() : null;
        const theirs = remoteChildren.get(dir)?.slice().sort();
        if (!sha || mine === null || theirs === undefined || mine.length !== theirs.length
            || !mine.every((v, i) => v === theirs[i])) {
          console.log(`  ${dir}: not reusable (vouched unchanged, but the two listings disagree)`);
          continue;
        }
        reused.set(dir, sha);
        console.log(`  ${dir}: reusable, ${theirs.length} entries match the last commit`);
      }
      console.log(`${reused.size} unchanged subtrees available for reuse`);
    }
  }
}

const rootSha = await ensure('');
const prev = (await api('/git/ref/heads/main', {}, 3)).json?.object?.sha;
// The commit message is the last thing that would fork, and it is the one field
// a caller is most likely to have in hand already, so it takes an override.
const message = (process.env.DSH_COMMIT_MSG
  ?? execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: CWD, encoding: 'utf8' })).trim();

const commit = await api('/git/commits', {
  method: 'POST',
  body: JSON.stringify({ message, tree: rootSha, parents: [prev] }),
});
if (commit.status !== 201) {
  console.error('commit failed', commit.status, JSON.stringify(commit.json).slice(0, 400));
  process.exit(1);
}
const ref = await api('/git/refs/heads/main', {
  method: 'PATCH', body: JSON.stringify({ sha: commit.json.sha, force: true }),
});
console.log('blobs uploaded:', uploaded.size);
console.log('commit:', commit.json.sha, '| update main:', ref.status);
console.log('DONE ->', `https://github.com/${REPO}/commit/${commit.json.sha}`);