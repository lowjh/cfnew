#!/usr/bin/env node
/**
 * Cloudflare 凭据诊断 v4（只读，不部署）
 *
 * 目标：把三种情形彻底分开
 *   A. 令牌本身无效/已过期        → 所有账户作用域端点都 9109
 *   B. 令牌有效但缺 Pages 权限     → /accounts/{id}/pages/... 报 10000，别的账户端点正常
 *   C. 令牌有效且权限齐全          → /accounts/{id}/tokens 列表能读出权限与过期时间
 *
 * 关键：GET /accounts/{id}/tokens 能列出该账号下的账户令牌，
 * 其中包含权限、过期时间、状态。这是判定 A/B/C 的权威依据。
 */

const CF_API = 'https://api.cloudflare.com/client/v4';
const token = (process.env.CF_API_TOKEN || '').trim();
const accountId = (process.env.CF_ACCOUNT_ID || '').trim();
const project = process.env.PAGES_PROJECT || 'cfnewup-dic';

const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function probe(label, url, headers) {
  let status = 0;
  let body = '';
  let raw = '';
  try {
    const res = await fetch(url, { headers });
    status = res.status;
    const text = await res.text();
    raw = text;
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (j && Array.isArray(j.errors) && j.errors.length) {
      body = j.errors.map((e) => `[${e.code}] ${e.message}`).join(' || ');
    } else if (j && j.success === true) {
      body = '成功';
    } else {
      body = text.slice(0, 250).replace(/\s+/g, ' ');
    }
  } catch (e) {
    body = '异常: ' + e.message;
  }
  console.log(`  ${label}\n      HTTP ${status}  ${body}`);
  return { status, body, raw };
}

async function main() {
  console.log('令牌前缀 = ' + token.slice(0, 5) + '_  长度=' + token.length +
    '  (cfat_ 账户令牌 / cfut_ 用户令牌 / cfk_ 全局Key)');
  console.log('Account ID = ' + accountId);
  console.log('');

  console.log('===== A. 令牌自身状态（最权威）=====');
  const list = await probe(
    `GET /accounts/${accountId}/tokens  (列出该账号的账户令牌)`,
    `${CF_API}/accounts/${accountId}/tokens`,
    auth
  );
  // 如果列表能读出，就打印每个令牌的名称/权限/过期/状态
  try {
    const j = JSON.parse(list.raw);
    if (j && j.success && Array.isArray(j.result)) {
      console.log('\n  --- 该账号下的账户令牌 ---');
      for (const t of j.result) {
        console.log(`   id=${t.id}`);
        console.log(`   name=${t.name}  status=${t.status}  expires=${t.expires_on || 'never'}`);
        const perms = (t.permissions || []).map((p) => `${p.id || p.name}`).join(', ');
        console.log(`   permissions=${perms || '(see detail)'}`);
      }
    }
  } catch {}

  console.log('\n===== B. 各服务作用域探测（看哪些通、哪些不通）=====');
  await probe('GET /accounts/{id}              (账户管理)', `${CF_API}/accounts/${accountId}`, auth);
  await probe('GET /accounts/{id}/tokens/verify', `${CF_API}/accounts/${accountId}/tokens/verify`, auth);
  await probe('GET /accounts/{id}/pages/projects (Pages 读)', `${CF_API}/accounts/${accountId}/pages/projects`, auth);
  await probe('GET /accounts/{id}/workers/scripts (Workers 读)', `${CF_API}/accounts/${accountId}/workers/scripts`, auth);
  await probe('GET /accounts/{id}/members        (成员读)', `${CF_API}/accounts/${accountId}/members`, auth);
  await probe('GET /accounts/{id}/subscriptions  (订阅读)', `${CF_API}/accounts/${accountId}/subscriptions`, auth);

  console.log('\n===== C. 结论 =====');
  console.log('  若 /accounts/{id}/tokens 成功 → 令牌有效，直接看它的 permissions 决定是否要重建');
  console.log('  若全部端点都 9109            → 令牌已失效/被吊销，必须换新');
  console.log('  若 pages 报 10000 而其他成功   → 令牌有效但缺 Cloudflare Pages 权限');
  console.log('  若其他成功 pages 报 10000     → 同上，需补 Pages:Edit');
  console.log('诊断结束。');
}

main().catch((e) => {
  console.error('诊断异常:', e.message);
  process.exit(1);
});
