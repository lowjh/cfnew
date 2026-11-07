#!/usr/bin/env node
/**
 * cfnew 上游同步 + 部署脚本
 *
 * 设计要点（针对历史三大故障）：
 *  1. 产物发现不依赖文件名 —— 用 GitHub tree API 一次拿到上游全部 blob，
 *     按规则挑选，上游改名不影响。
 *  2. 幂等判断基于 blob SHA（内容哈希），而不是 commit SHA。
 *     上游改名但内容没变 -> SHA 不变 -> 不触发部署；
 *     内容真的变了       -> SHA 变   -> 触发部署。
 *  3. 云端响应必须校验 success 字段，失败立刻 exit 1（杜绝"假绿"）。
 *  4. 状态文件只在部署成功后写入（失败不污染状态）。
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const UPSTREAM_REPO = process.env.UPSTREAM_REPO || 'byJoey/cfnew';
const UPSTREAM_BRANCH = process.env.UPSTREAM_BRANCH || 'main';
const UPSTREAM_REF = process.env.UPSTREAM_REF || 'refs/heads/main';

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const PAGES_PROJECT = process.env.PAGES_PROJECT || '';

const STATE_FILE = '.upstream-state.json';

// GitHub 凭据：优先用 GITHUB_TOKEN（workflow 自带），否则匿名（公开仓库够用）
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`::error::缺少必需环境变量 ${name}`);
    process.exit(1);
  }
  return v;
}

function log(msg) {
  console.log(msg);
}

function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'cfnew-sync' };
  if (GH_TOKEN) h.Authorization = `Bearer ${GH_TOKEN}`;
  return h;
}

/** Cloudflare 认证头：优先 API Token，回退 Global API Key */
function cfHeaders() {
  if (process.env.CF_API_TOKEN) {
    return { Authorization: `Bearer ${process.env.CF_API_TOKEN}` };
  }
  if (process.env.CF_API_KEY && process.env.CF_EMAIL) {
    return { 'X-Auth-Email': process.env.CF_EMAIL, 'X-Auth-Key': process.env.CF_API_KEY };
  }
  console.error('::error::缺少 Cloudflare 凭据：需要 CF_API_TOKEN，或 CF_API_KEY + CF_EMAIL');
  process.exit(1);
}

/**
 * 产物挑选规则：
 *  - 必须是 blob
 *  - 排除目录、README/说明类、源码（明文）、压缩包、配置
 *  - 剩下的取体积最大的那个 —— 混淆后的完整面板是最大的产物
 */
function pickArtifact(blobs) {
  const EXCLUDE_EXACT = new Set(['README.md', 'wrangler.toml', 'package.json', 'LICENSE', 'VERSION.txt']);
  const EXCLUDE_SUBSTR = ['明文', 'README', '.md', '.zip', '.tar', '.gz', '.json', '.toml', '.txt', '.yml', '.yaml'];
  const candidates = blobs.filter((b) => {
    if (b.type !== 'blob') return false;
    if (EXCLUDE_EXACT.has(b.path)) return false;
    if (EXCLUDE_SUBSTR.some((s) => b.path.includes(s))) return false;
    return b.size > 100 * 1024; // 完整面板至少几百 KB
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0];
}

async function fetchTree() {
  const url = `https://api.github.com/repos/${UPSTREAM_REPO}/git/trees/${UPSTREAM_REF}?recursive=1`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    console.error(`::error::获取上游 tree 失败 ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  if (!data.tree) {
    console.error('::error::上游 tree 返回异常');
    process.exit(1);
  }
  return { sha: data.sha, tree: data.tree };
}

function readState() {
  try {
    return JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function downloadBlob(sha) {
  const url = `https://api.github.com/repos/${UPSTREAM_REPO}/git/blobs/${sha}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    console.error(`::error::下载 blob 失败 ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  if (data.encoding !== 'base64') {
    console.error(`::error::blob 编码异常: ${data.encoding}`);
    process.exit(1);
  }
  return Buffer.from(data.content, 'base64');
}

/** 生成 Pages 部署目录：_worker.js + wrangler.toml */
function buildPagesDir(workerBuf) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfnew-deploy-'));
  fs.writeFileSync(path.join(dir, '_worker.js'), workerBuf);
  fs.writeFileSync(
    path.join(dir, 'wrangler.toml'),
    'name = "' + PAGES_PROJECT + '"\ncompatibility_date = "2026-01-20"\n'
  );
  return dir;
}

/**
 * 用 wrangler 部署到 Pages。
 * wrangler 会自动生成正确的 assets manifest，且同时支持
 * CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL 两种凭据。
 */
async function deployToPages(dir) {
  const { execFileSync } = require('child_process');
  const args = [
    'wrangler@4',
    'pages',
    'deploy',
    dir,
    '--project-name',
    PAGES_PROJECT,
    '--branch',
    process.env.DEPLOY_BRANCH || 'main',
    '--commit-dirty=true',
    '--commit-message',
    `sync from ${UPSTREAM_REPO}@${UPSTREAM_BRANCH}`,
  ];
  let stdout = '';
  try {
    stdout = execFileSync('npx', ['-y', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: process.env.CF_API_TOKEN || '',
        CLOUDFLARE_API_KEY: process.env.CF_API_KEY || '',
        CLOUDFLARE_EMAIL: process.env.CF_EMAIL || '',
      },
    });
    log(stdout);
  } catch (e) {
    console.error('::error::wrangler 部署失败');
    console.error('--- stdout ---');
    console.error(String(e.stdout || '').slice(-3000));
    console.error('--- stderr ---');
    console.error(String(e.stderr || '').slice(-3000));
    process.exit(1);
  }
  // 校验输出里有成功部署的 URL，没有就是失败
  if (!/https?:\/\/\S+\.pages\.dev/.test(stdout)) {
    console.error('::error::wrangler 输出中未找到部署 URL，判定为失败');
    console.error(stdout.slice(-2000));
    process.exit(1);
  }
  const url = stdout.match(/https?:\/\/\S+\.pages\.dev/)[0];
  return { url };
}

async function main() {
  log(`上游仓库: ${UPSTREAM_REPO} (${UPSTREAM_BRANCH})`);
  log(`部署目标: Pages 项目 ${PAGES_PROJECT}`);

  const { sha: treeSha, tree } = await fetchTree();
  log(`上游 tree sha: ${treeSha}`);

  const artifact = pickArtifact(tree);
  if (!artifact) {
    console.error('::error::未能在上游找到符合条件的产物');
    process.exit(1);
  }
  log(`选定产物: ${artifact.path}  size=${artifact.size}  blobSha=${artifact.sha}`);

  const state = readState();
  const prevSha = state.artifactSha || '';

  if (prevSha === artifact.sha) {
    log('内容未变化（blob SHA 相同），跳过部署。');
    log('::notice::无更新');
    return;
  }
  log(`检测到内容变化: ${prevSha || '(无记录)'} -> ${artifact.sha}`);

  const buf = await downloadBlob(artifact.sha);
  log(`已下载 ${buf.length} 字节`);

  // 内容安全校验：worker 产物应包含 export default（混淆后位置不固定，需全文搜）
  const text = buf.toString('utf8');
  if (!/export\s+default/.test(text)) {
    console.error('::error::下载内容不含 export default，不像有效的 worker 脚本，已中止部署');
    process.exit(1);
  }

  const dir = buildPagesDir(buf);
  log('已准备 Pages 部署目录');

  const result = await deployToPages(dir);
  log(`部署成功: ${result.url}`);

  // 只有部署成功才写状态
  const fs = require('fs');
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        artifactSha: artifact.sha,
        artifactPath: artifact.path,
        artifactSize: artifact.size,
        treeSha,
        deployedAt: new Date().toISOString(),
        url: result.url,
      },
      null,
      2
    ) + '\n'
  );
  log('状态已写入 ' + STATE_FILE);
  fs.rmSync(dir, { recursive: true, force: true });

  log('::notice::部署完成');
}

main().catch((e) => {
  console.error('::error::' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
