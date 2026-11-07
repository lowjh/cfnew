#!/usr/bin/env node
/**
 * Cloudflare 凭据诊断脚本 —— 只读探测，不部署、不修改任何东西。
 *
 * 目的：搞清楚 secrets.CF_API_TOKEN 到底是什么形态，导致 wrangler 报
 *   [code: 9109] Invalid access token
 *   [code: 10000] Authentication error
 *
 * 打印内容全部是「形状信息」（长度 / 是否十六进制 / 是否含空白），
 * 绝不打印凭据本身。
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

const token = process.env.CF_API_TOKEN || '';
const apiKey = process.env.CF_API_KEY || '';
const email = process.env.CF_EMAIL || '';
const accountId = process.env.CF_ACCOUNT_ID || '';

function shape(label, v) {
  if (!v) {
    console.log(`${label}: (空)`);
    return;
  }
  const trimmed = v.trim();
  console.log(`${label}:`);
  console.log(`  原始长度          = ${v.length}`);
  console.log(`  trim 后长度       = ${trimmed.length}`);
  console.log(`  长度是否相等      = ${v.length === trimmed.length}  (不等说明首尾有空白/换行)`);
  console.log(`  含空白字符        = ${/\s/.test(v)}`);
  console.log(`  全部十六进制      = ${/^[0-9a-fA-F]+$/.test(trimmed)}`);
  console.log(`  形如 Global Key   = ${/^[0-9a-fA-F]{37}$/.test(trimmed)}  (37位十六进制 = Global API Key)`);
  console.log(`  形如 API Token    = ${trimmed.length >= 40 && !/^[0-9a-fA-F]+$/.test(trimmed)}`);
}

async function probe(label, url, headers) {
  let status = 0;
  let out = '';
  try {
    const res = await fetch(url, { headers });
    status = res.status;
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    if (parsed && Array.isArray(parsed.errors) && parsed.errors.length) {
      out = parsed.errors.map((e) => `${e.code}:${e.message}`).join(' | ');
    } else if (parsed && parsed.success === true) {
      const r = parsed.result;
      if (Array.isArray(r)) {
        out = `成功，返回 ${r.length} 项: ` + r.map((x) => x.name || x.id).join(', ');
      } else {
        out = '成功: ' + JSON.stringify(r).slice(0, 200);
      }
    } else {
      out = text.slice(0, 300).replace(/\s+/g, ' ');
    }
  } catch (e) {
    out = '请求异常: ' + e.message;
  }
  console.log(`  [${label}] HTTP ${status} -> ${out}`);
  return { status, out };
}

async function main() {
  console.log('===== Cloudflare 凭据形态诊断 =====');
  shape('CF_API_TOKEN', token);
  shape('CF_API_KEY  ', apiKey);
  shape('CF_EMAIL   ', email);
  shape('CF_ACCOUNT_ID', accountId);

  console.log('\n===== 认证方式探测 =====');

  if (token) {
    await probe('Bearer 原始值', `${CF_API}/accounts`, {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });
    if (token !== token.trim()) {
      await probe('Bearer trim 后', `${CF_API}/accounts`, {
        Authorization: `Bearer ${token.trim()}`,
        'Content-Type': 'application/json',
      });
    }
    await probe('Bearer /user/tokens/verify', `${CF_API}/user/tokens/verify`, {
      Authorization: `Bearer ${token.trim()}`,
      'Content-Type': 'application/json',
    });
  }

  if (email && apiKey) {
    await probe('X-Auth-Email + X-Auth-Key', `${CF_API}/accounts`, {
      'X-Auth-Email': email,
      'X-Auth-Key': apiKey,
      'Content-Type': 'application/json',
    });
  } else {
    console.log('  [X-Auth 模式] 跳过：CF_EMAIL 或 CF_API_KEY 未配置');
  }

  console.log('\n===== 结论参考 =====');
  console.log('  9109 Invalid access token → Bearer 的值不是合法 API Token（常见：填的是 Global API Key，或 secret 带尾部换行）');
  console.log('  10000 Authentication error → 认证通过但对目标资源无权限，或 account id 与凭据不属于同一账号');
  console.log('  Global API Key 必须配合邮箱用 X-Auth-Email + X-Auth-Key 发送，不能当 Bearer 用');
  console.log('\n诊断结束。');
}

main().catch((e) => {
  console.error('诊断脚本异常:', e.message);
  process.exit(1);
});
