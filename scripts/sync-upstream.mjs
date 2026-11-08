#!/usr/bin/env node
// 把上游 byJoey/cfnew 的产物同步进本仓库（lowjh/cfnew）。
//
// 链路说明（零 Cloudflare 令牌）：
//   上游 byJoey/cfnew 更新
//     -> 本脚本只读拉取上游产物，提交进本仓库 main
//       -> Cloudflare Pages（Git 集成，关联本仓库）自动重建部署
//
// 凭据只用 GitHub 自带的 GITHUB_TOKEN，不需要任何 Cloudflare 凭据。

const API = 'https://api.github.com';
const UPSTREAM = 'byJoey/cfnew';
const UPSTREAM_REF = 'main';
const 本仓库 = process.env.GITHUB_REPOSITORY || 'lowjh/cfnew';
const 分支 = process.env.TARGET_BRANCH || 'main';

// 只同步上游已混淆好的产物（上游自己的 obfuscate 工作流已保证它与上游明文源一致）。
// 不同步「明文源吗」，避免触发本仓库的 obfuscate.yml 产生额外提交。
const 同步文件 = ['少年你相信光吗'];

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('缺少 GITHUB_TOKEN');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'cfnew-sync-upstream',
};

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, { ...options, headers });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const msg = json?.message || text.slice(0, 200);
    throw new Error(`API ${res.status} ${path}: ${msg}`);
  }
  return json;
}

async function 读上游文件(路径) {
  const 数据 = await api(
    `/repos/${UPSTREAM}/contents/${encodeURIComponent(路径)}?ref=${UPSTREAM_REF}`
  );
  if (!数据 || Array.isArray(数据) || 数据.type !== 'file') {
    throw new Error(`上游文件不存在或不是普通文件: ${路径}`);
  }
  const res = await fetch(数据.download_url, { headers: { 'User-Agent': 'cfnew-sync-upstream' } });
  if (!res.ok) throw new Error(`下载上游文件失败 ${res.status}: ${路径}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { sha: 数据.sha, 内容: buf, 大小: buf.length };
}

async function 读本仓库文件(路径) {
  try {
    const 数据 = await api(`/repos/${本仓库}/contents/${encodeURIComponent(路径)}?ref=${分支}`);
    if (!数据 || 数据.type !== 'file') return null;
    return { sha: 数据.sha, 大小: 数据.size };
  } catch (err) {
    if (String(err.message).includes('404')) return null;
    throw err;
  }
}

async function 写本仓库文件(路径, 内容, 消息) {
  const base64 = Buffer.from(内容).toString('base64');
  await api(`/repos/${本仓库}/contents/${encodeURIComponent(路径)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 消息,
      content: base64,
      branch: 分支,
      committer: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' },
      author: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' },
    }),
  });
}

async function 主流程() {
  console.log(`上游仓库: ${UPSTREAM} (${UPSTREAM_REF})`);
  console.log(`目标仓库: ${本仓库} (${分支})`);

  const 待提交 = [];

  for (const 路径 of 同步文件) {
    const 上游文件 = await 读上游文件(路径);
    const 本地文件 = await 读本仓库文件(路径);
    const 相同 = 本地文件 && 本地文件.sha === 上游文件.sha;
    if (相同) {
      console.log(`无变化: ${路径} (blob ${上游文件.sha.slice(0, 8)})`);
      continue;
    }
    console.log(
      `有变化: ${路径} ${本地文件 ? `blob ${本地文件.sha.slice(0, 8)}` : '(不存在)'} -> ${上游文件.sha.slice(0, 8)} (${上游文件.大小} 字节)`
    );
    待提交.push({ 路径, 内容: 上游文件.内容 });
  }

  if (待提交.length === 0) {
    console.log('上游无更新，无需提交。');
    return;
  }

  for (const 项 of 待提交) {
    await 写本仓库文件(项.路径, 项.内容, '同步上游产物');
    console.log(`已提交: ${项.路径}`);
  }

  console.log('提交完成，Cloudflare Pages 将自动重建部署。');
}

主流程().catch((err) => {
  console.error('同步失败:', err.message);
  process.exit(1);
});
