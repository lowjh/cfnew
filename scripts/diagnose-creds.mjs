#!/usr/bin/env node
/**
 * Cloudflare 凭据深度诊断（只读，不部署）
 *
 * 目标：区分三种情形
 *   A. token 完全无效
 *   B. token 有效，但缺某些端点的权限（属于不同账号 / 缺 Account Settings Read）
 *   C. token 与 CF_ACCOUNT_ID 不属于同一账号
 *
 * 打印 token 的前缀特征（只露前 6 后 4 位），用于判断 token 类型。
 */

const CF_API = 'https://api.cloudflare.com/client/v4';
const token = (process.env.CF_API_TOKEN || '').trim();
const accountId = (process.env.CF_ACCOUNT_ID || '').trim();
const project = process.env.PAGES_PROJECT || 'cfnewup-dic';

function tokenSignature(v) {
  if (!v) return '(空)';
  const head = v.slice(0, 6);
  const tail = v.slice(-4);
  const charset = {
    有连字符: v.includes('-'),
    有下划线: v.includes('_'),
    有点: v.includes('.'),
    有冒号: v.includes(':'),
    有空格: v.includes(' '),
    纯数字: /^[0-9]+$/.test(v),
    base62: /^[A-Za-z0-9]+$/.test(v),
    看起来像JWT: v.split('.').length === 3,
  };
  const marks = Object.entries(charset)
    .filter(([, yes]) => yes)
    .map(([k]) => k)
    .join(', ');
  return `前6=${head}… 后4=…${tail}  特征: ${marks || '(无特殊字符)'}`;
}

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
      if (Array.isArray(r)) body = `成功，${r.length} 项` + (r.length ? ' → ' + r.slice(0, 5).map((x) => x.name || x.id).join(', ') : '');
      else body = '成功 → ' + JSON.stringify(r).slice(0, 300);
    } else {
      body = text.slice(0, 300).replace(/\s+/g, ' ');
    }
  } catch (e) {
    body = '异常: ' + e.message;
  }
  console.log(`  ${label}\n      HTTP ${status}  ${body}`);
  return { status, body };
}

const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function main() {
  console.log('===== 1. 凭据形态 =====');
  console.log('CF_API_TOKEN: ' + tokenSignature(token));
  console.log('CF_ACCOUNT_ID: 长度=' + accountId.length + ' 十六进制=' + /^[0-9a-f]{32}$/i.test(accountId));
  console.log('');

  console.log('===== 2. 逐端点探测（Bearer）=====');
  await probe('GET /user/tokens/verify', `${CF_API}/user/tokens/verify`, auth);
  await probe('GET /accounts', `${CF_API}/accounts`, auth);
  await probe('GET /accounts/{id}', `${CF_API}/accounts/${accountId}`, auth);
  await probe(`GET /accounts/{id}/pages/projects/${project}`, `${CF_API}/accounts/${accountId}/pages/projects/${project}`, auth);
  await probe(`GET /accounts/{id}/pages/projects (列表)`, `${CF_API}/accounts/${accountId}/pages/projects`, auth);
  await probe('GET /zones', `${CF_API}/zones`, auth);

  console.log('\n===== 3. 结论判定 =====');
  console.log('  /user/tokens/verify 401/1000  → token 已被 Cloudflare 判定无效（换 token 或改用 Global Key）');
  console.log('  /user/tokens/verify 200       → token 本身有效，后续 403 是端点权限或账号不匹配');
  console.log('  /accounts 403/9109            → 缺 Account Settings Read，wrangler 因先查 /accounts 而失败');
  console.log('  /accounts/{id}/pages/... 成功  → 权限与账号都对，问题只在 wrangler 的调用顺序');
  console.log('诊断结束。');
}

main().catch((e) => {
  console.error('诊断异常:', e.message);
  process.exit(1);
});
