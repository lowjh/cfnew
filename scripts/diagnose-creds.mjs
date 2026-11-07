#!/usr/bin/env node
/**
 * Cloudflare 凭据深度诊断 v3（只读，不部署）
 *
 * 背景：CF_API_TOKEN 是 account-owned token（cfat_ 前缀），
 * 它不是 user token，因此：
 *   - /user/tokens/verify  -> 401/1000 是正常的（该端点只认用户令牌）
 *   - /accounts、/zones    -> 403/9109 是正常的（账户令牌无用户作用域）
 * 账户令牌的正确验证端点是 /accounts/{account_id}/tokens/verify
 */

const CF_API = 'https://api.cloudflare.com/client/v4';
const token = (process.env.CF_API_TOKEN || '').trim();
const accountId = (process.env.CF_ACCOUNT_ID || '').trim();
const project = process.env.PAGES_PROJECT || 'cfnewup-dic';

// 已知的老大账号（来自 Cloudflare 控制台 / 上次手工验证记录）
const KNOWN_ACCOUNT = 'fa16b37ea19c5c91ac0565f658fdadd8';

const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function probe(label, url, headers) {
  let status = 0;
  let body = '';
  try {
    const res = await fetch(url, { headers });
    status = res.status;
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (j && Array.isArray(j.errors) && j.errors.length) {
      body = j.errors.map((e) => `[${e.code}] ${e.message}`).join(' || ');
    } else if (j && j.success === true) {
      const r = j.result;
      body = '成功 → ' + JSON.stringify(r).slice(0, 400);
    } else {
      body = text.slice(0, 300).replace(/\s+/g, ' ');
    }
  } catch (e) {
    body = '异常: ' + e.message;
  }
  console.log(`  ${label}\n      HTTP ${status}  ${body}`);
  return { status, body };
}

async function main() {
  console.log('===== 凭据形态 =====');
  console.log('CF_API_TOKEN 前6 = ' + token.slice(0, 6) + '…  长度=' + token.length);
  console.log('CF_ACCOUNT_ID   = ' + accountId);
  console.log('已知账号ID      = ' + KNOWN_ACCOUNT);
  console.log('两者是否一致    = ' + (accountId === KNOWN_ACCOUNT));
  console.log('');

  console.log('===== 用正确的 account-token 端点验证 =====');
  await probe(
    `GET /accounts/${accountId}/tokens/verify`,
    `${CF_API}/accounts/${accountId}/tokens/verify`,
    auth
  );
  if (accountId !== KNOWN_ACCOUNT) {
    await probe(
      `GET /accounts/{已知ID}/tokens/verify`,
      `${CF_API}/accounts/${KNOWN_ACCOUNT}/tokens/verify`,
      auth
    );
  }

  console.log('\n===== 目标资源可达性 =====');
  await probe(
    `GET /accounts/${accountId}/pages/projects/${project}`,
    `${CF_API}/accounts/${accountId}/pages/projects/${project}`,
    auth
  );
  await probe(
    `GET /accounts/${accountId}/pages/projects`,
    `${CF_API}/accounts/${accountId}/pages/projects`,
    auth
  );

  console.log('\n===== 结论 =====');
  console.log('  /accounts/{id}/tokens/verify 200 → 令牌有效且属于该 account');
  console.log('  1001 Missing Authorization        → 请求没带上头（诊断脚本 bug）');
  console.log('  10000 Authentication error       → account id 与令牌所属账号不符');
  console.log('  9109 Invalid access token       → 令牌无效/已吊销，或账户作用域端点不接受');
  console.log('诊断结束。');
}

main().catch((e) => {
  console.error('诊断异常:', e.message);
  process.exit(1);
});
