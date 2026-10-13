#!/usr/bin/env node
/**
 * Upload this repository to GitHub with the REST API, without installing git.
 *
 * Why a script and not a one-off command: the token must not end up in a shell command line, in
 * this session's transcript, or in a log. So it is read from a local file, and the file is deleted
 * as soon as the upload finishes — including when it fails.
 *
 * Usage:
 *   1. Create a token (fine-grained, permission: Repository permissions → Contents → Read and write)
 *        https://github.com/settings/personal-access-tokens/new
 *   2. Save it to a file, one line, nothing else:
 *        D:\DSHcode\dsh-mobile\.github-token
 *   3. node github-upload.mjs --repo dsh-mobile --user <你的用户名>
 *
 * Optional flags:
 *   --repo <name>     repository name            (default: dsh-mobile)
 *   --user <login>    your GitHub login          (required)
 *   --private         create it private          (default: public)
 *   --description <s> repository description
 *   --keep-token      do not delete the token file afterwards
 *   --dry-run         print the plan, touch nothing
 *   --release <tag>   also create a release (e.g. v8.9) and attach files to it
 *   --assets a,b,c    the files to attach (comma separated); same-named ones are replaced
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.github.com';
/**
 * The token lives *outside* the repository on purpose: inside it, a forgotten file would be one
 * `git add -A` away from being published, which is the one mistake this whole script exists to
 * avoid.
 */
const TOKEN_FILE = join(HERE, '..', '.github-token');

/** Never uploaded: repository metadata and local build output. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'out', '.github']);
const SKIP_FILES = new Set(['.github-token', 'github-upload.mjs']);

const DEFAULT_DESCRIPTION =
  '在手机上直接用 DSH：配对面板与二维码、一次性令牌与长期密钥、已配对设备门控，以及可选的公网隧道。 '
  + 'Use the DSH Web GUI from a phone: pairing panel, one-time tokens, device gate, optional tunnel.';

const HELP = `把 repo/ 目录上传到 GitHub，不需要安装 git。

用法：
  node github-upload.mjs --user <你的GitHub用户名> [选项]

选项：
  --repo <name>       仓库名（默认 dsh-mobile）
  --user <login>      你的 GitHub 用户名（可省略，脚本会用 token 身份识别）
  --private           建成私有仓库（默认公开）
  --description <s>   仓库描述
  --release <tag>     顺带创建 Release 并上传附件，例如 --release v8.9
  --assets a,b,c      要上传到 Release 的文件（逗号分隔，同名附件会被替换）
  --dry-run           只打印计划，不做任何网络请求，也不消耗 token
  --keep-token        跑完保留 token 文件（默认删除）
  --help              显示这份说明

token：
  生成地址（细粒度，权限只要 Repository permissions → Contents: Read and write）
    https://github.com/settings/personal-access-tokens/new
  然后把它写进这个文件，只有一行：
    ` + TOKEN_FILE + `

注意：
  · token 文件放在仓库外面，避免误提交；
  · 只在真正上传时才删除 token 文件（--dry-run 和参数错误都不会删）；
  · 如果报 TLS 证书错误（UNABLE_TO_VERIFY_LEAF_SIGNATURE），说明本机有 TLS 拦截，
    用 node --use-system-ca github-upload.mjs …（或设 NODE_OPTIONS=--use-system-ca）。
`;

function parseArgs(argv) {
  const args = { repo: 'dsh-mobile', user: '', isPrivate: false, description: DEFAULT_DESCRIPTION, keepToken: false, dryRun: false, release: '', assets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--private') args.isPrivate = true;
    else if (a === '--description') args.description = argv[++i];
    else if (a === '--keep-token') args.keepToken = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--release') args.release = argv[++i];
    else if (a === '--assets') args.assets = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') args.help = true;
    // Reject anything else instead of ignoring it. Silently dropping a typo (or a flag meant for a
    // different script) turns a mistake into a real upload against a real repository.
    else throw new Error('未知参数：' + a
      + '\n可用参数：--repo --user --private --description --keep-token --dry-run --release --assets');
  }
  return args;
}

/** Every file to upload, as repository-relative paths. */
function collectFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) continue;
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

async function api(token, method, path, body, expect = [200, 201]) {
  const response = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-mobile-uploader',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    json = null;
  }
  if (!expect.includes(response.status)) {
    const detail = json && json.message ? json.message : text.slice(0, 200);
    const hint = response.status === 401 ? '  → token 无效或已过期'
      : response.status === 403 ? '  → token 权限不足（需要 Contents: Read and write）'
      : response.status === 404 ? '  → 用户名或仓库名不对，或 token 无权访问'
      : '';
    throw new Error(method + ' ' + path + ' -> HTTP ' + response.status + ': ' + detail + hint);
  }
  return { status: response.status, json };
}

async function main(args, onTokenUsed) {
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!existsSync(TOKEN_FILE)) {
    throw new Error('找不到 token 文件：' + TOKEN_FILE
      + '\n请把 token 写进这个文件（只有一行，不要有其它内容）。');
  }
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!token) throw new Error('token 文件是空的');

  const files = collectFiles(HERE);
  const total = files.reduce((sum, f) => sum + statSync(f).size, 0);
  console.log('目标仓库  : ' + (args.user ? args.user + '/' : '(自动识别账号)/') + args.repo
    + (args.isPrivate ? ' (私有)' : ' (公开)'));
  console.log('本地目录  : ' + HERE);
  console.log('待上传    : ' + files.length + ' 个文件, ' + (total / 1024).toFixed(1) + ' KB');
  console.log('token     : 已从 ' + TOKEN_FILE + ' 读取（不会出现在命令行里）');
  console.log();

  if (args.dryRun) {
    for (const f of files.slice(0, 12)) console.log('  ' + relative(HERE, f));
    if (files.length > 12) console.log('  … 还有 ' + (files.length - 12) + ' 个');
    console.log();
    console.log('dry run 结束，没有发起任何请求。');
    return;
  }

  // Only now is the token genuinely spent — the argument checks are behind us and a dry run has
  // already returned, so the cleanup that follows cannot throw away a credential unnecessarily.
  onTokenUsed();

  // 1. Who is this token?
  const me = await api(token, 'GET', '/user');
  console.log('已认证为  : ' + me.json.login);
  if (args.user && me.json.login.toLowerCase() !== args.user.toLowerCase()) {
    console.log('  注意：--user 是 "' + args.user + '"，而 token 属于 "' + me.json.login + '"，按后者的账号上传。');
  }
  // The token's own identity always wins: it is the account the commit will belong to, and it
  // removes the need to know the login ahead of time.
  args.user = me.json.login;

  // 2. Create the repository, or reuse it if it already exists.
  const repoPath = '/repos/' + args.user + '/' + args.repo;
  let created = false;
  try {
    await api(token, 'POST', '/user/repos', {
      name: args.repo,
      description: args.description,
      private: args.isPrivate,
      auto_init: false
    });
    created = true;
    console.log('仓库      : 已创建');
  } catch (error) {
    if (!/HTTP 422/.test(error.message)) throw error;
    console.log('仓库      : 已存在，继续提交');
  }

  /**
   * Make sure the repository has at least one commit.
   *
   * The Git Data API refuses to write blobs into an empty repository (`409 Git Repository is
   * empty`) — it needs a commit to hang objects off. Creating a file through the contents API is
   * the one write that does work on an empty repo, and it establishes the default branch as a side
   * effect. The file is put in a subdirectory so the repository root still holds exactly what was
   * uploaded.
   */
  async function ensureInitialCommit() {
    const info = await api(token, 'GET', repoPath);
    const branch = info.json.default_branch || 'main';
    try {
      await api(token, 'GET', repoPath + '/contents/.github-upload-bootstrap');
      return branch; // Already there from an earlier run.
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
    }
    const body = {
      message: 'chore: 初始化仓库（上传脚本建立基线提交）',
      content: Buffer.from('This directory exists so the first commit can be created.\n'
        + 'The Git Data API cannot write into a repository with no commits.\n', 'utf8').toString('base64'),
      branch
    };
    try {
      await api(token, 'PUT', repoPath + '/contents/.github-upload-bootstrap/README.txt', body);
      console.log('初始化    : 已建立基线提交');
    } catch (error) {
      // A token without Contents write cannot do this; let the caller fail with the real reason
      // rather than hiding it behind a cleanup.
      throw new Error('无法在空仓库里建立初始提交：' + error.message);
    }
    return branch;
  }

  const baseBranch = await ensureInitialCommit();

  // 3. Upload every file as a blob, then build one tree from them.
  const tree = [];
  for (let i = 0; i < files.length; i++) {
    const full = files[i];
    const path = relative(HERE, full).replace(/\\/g, '/');
    const content = readFileSync(full);
    const blob = await api(token, 'POST', repoPath + '/git/blobs', {
      content: content.toString('base64'),
      encoding: 'base64'
    });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.json.sha });
    process.stdout.write('\r  上传中 ' + (i + 1) + '/' + files.length + '  ' + path.slice(0, 44).padEnd(46));
  }
  console.log();

  const newTree = await api(token, 'POST', repoPath + '/git/trees', { tree });
  const message = created
    ? 'dsh-mobile: 手机端远程访问插件（配对面板、令牌、设备门控、公网隧道）'
    : '更新 dsh-mobile 插件';
  const commit = await api(token, 'POST', repoPath + '/git/commits', {
    message,
    tree: newTree.json.sha,
    parents: []
  });

  // 4. Point the default branch at this commit.
  //
  // The commit is a fresh root (no parents), so this one commit is the entire history and the
  // bootstrap file from step 2 is not in its tree — the repository ends up holding exactly the
  // uploaded files. The force flag is what lets a second run replace the branch instead of failing.
  const branch = baseBranch;
  try {
    await api(token, 'POST', repoPath + '/git/refs', {
      ref: 'refs/heads/' + branch,
      sha: commit.json.sha
    });
    console.log('分支      : 已创建 ' + branch);
  } catch (error) {
    if (!/HTTP 422/.test(error.message)) throw error;
    await api(token, 'PATCH', repoPath + '/git/refs/heads/' + branch, {
      sha: commit.json.sha,
      force: true
    });
    console.log('分支      : 已更新 ' + branch);
  }

  console.log();
  console.log('完成 ✔  https://github.com/' + args.user + '/' + args.repo);
  console.log('提交      : ' + commit.json.sha.slice(0, 12) + '  文件 ' + files.length + ' 个');

  // 5. Optionally attach the built artifacts to a release. A binary belongs in a release rather
  //    than the repository: Git keeps every version of every committed file forever, so repeatedly
  //    committing a rebuilt APK grows the repository without bound.
  if (args.release) {
    await publishRelease(token, args.user, args.repo, args.release, args.assets);
  }
}

/** Upload the given files to a release, creating the tag/release if needed. Idempotent. */
async function publishRelease(token, user, repo, tag, assets) {
  const repoPath = '/repos/' + user + '/' + repo;
  console.log();
  console.log('发布 Release: ' + tag);
  const existing = assets.filter((a) => existsSync(a));
  if (existing.length === 0) {
    console.log('  没有找到要上传的文件，跳过。');
    return;
  }
  for (const a of existing) console.log('  ' + statSync(a).size.toLocaleString() + ' 字节  ' + a);

  let release;
  try {
    release = await api(token, 'GET', repoPath + '/releases/tags/' + encodeURIComponent(tag));
    console.log('  Release 已存在，将补充附件');
  } catch (error) {
    if (!/HTTP 404/.test(error.message)) throw error;
    release = await api(token, 'POST', repoPath + '/releases', {
      tag_name: tag,
      name: tag,
      target_commitish: 'main',
      body: '手机端 APK 与图文教程。\n\n安装步骤见压缩包内的《快速开始.txt》与《使用说明.txt》。',
      draft: false,
      prerelease: false
    });
    console.log('  Release 已创建');
  }

  // Replace an attachment with the same name so re-running after a rebuild does not pile up copies.
  const current = await api(token, 'GET', repoPath + '/releases/' + release.json.id + '/assets');
  for (const asset of existing) {
    const name = asset.split(/[\\/]/).pop();
    const previous = (current.json || []).find((a) => a.name === name);
    if (previous) {
      await api(token, 'DELETE', repoPath + '/releases/assets/' + previous.id, null, [204]);
      console.log('  已移除旧附件 ' + name);
    }
    const data = readFileSync(asset);
    const response = await fetch('https://uploads.github.com' + repoPath + '/releases/'
      + release.json.id + '/assets?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
        'User-Agent': 'dsh-mobile-uploader'
      },
      body: data
    });
    if (response.status !== 201) {
      throw new Error('上传附件 ' + name + ' 失败：HTTP ' + response.status + ' '
        + (await response.text()).slice(0, 160));
    }
    console.log('  已上传 ' + name);
  }
  console.log('  Release: https://github.com/' + user + '/' + repo + '/releases/tag/'
    + encodeURIComponent(tag));
}

let tokenFileDeleted = false;
/**
 * Delete the token file, but only when the token was actually used.
 *
 * The first version deleted it on every exit path, including a run that failed its own argument
 * check before making a single request — which threw away a working credential. A failed argument
 * check is not a reason to destroy anything.
 */
function cleanupToken(args, tokenWasUsed) {
  if (tokenFileDeleted || args.keepToken || !tokenWasUsed) return;
  try {
    if (existsSync(TOKEN_FILE)) {
      rmSync(TOKEN_FILE, { force: true });
      tokenFileDeleted = true;
      // Best-effort deletion with a clear message rather than a silent one: not every filesystem
      // can guarantee the bytes are gone.
      console.log('已删除 token 文件（如想保留请加 --keep-token）');
    }
  } catch (error) {
    console.log('警告：token 文件删除失败，请手动删除 ' + TOKEN_FILE);
  }
}

// Parsed once, before anything else: a bad flag should be reported as a bad flag, not as a failed
// upload, and it must not be able to touch the token file.
let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

let used = false;
try {
  await main(args, () => {
    used = true;
  });
  cleanupToken(args, used);
} catch (error) {
  console.error('上传失败: ' + error.message);
  cleanupToken(args, used);
  process.exit(1);
}
