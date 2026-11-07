# cfnew 自动同步与部署

上游仓库：[`byJoey/cfnew`](https://github.com/byJoey/cfnew)

本仓库的 `Auto Deploy CFnew` workflow 每 6 小时检查一次上游，一旦内容有更新，
自动拉取最新产物并部署到 Cloudflare Pages 项目 **`cfnewup-dic`**。

线上地址：<https://cf.louwh.bond/louwh>（CNAME → `cfnewup-dic.pages.dev`）

## 工作原理

```
GitHub tree API  →  规则挑选产物  →  blob SHA 比对  →  wrangler pages deploy
```

### 1. 产物发现不依赖文件名

不使用 `curl raw.githubusercontent.com/.../少年你相信光吗` 这类硬编码路径，
而是调用 `GET /repos/byJoey/cfnew/git/trees/main?recursive=1` 一次性拿到上游
全部 blob 的 `path` / `size` / `sha`，再按规则筛选：

- 排除 `README.md`、`*.md`、`*.json`、`*.toml` 等文档与配置
- 排除文件名含 `明文` 的源码文件
- 剩余候选中取体积最大者（完整混淆面板约 1.7 MB）

**上游改名不会导致失败。** 历史上 `cfnext-deployer` 就是因为写死
`CFNext-混淆版.js`，上游 10-31 改名为 `CFNext-小说混淆版.js` 后连续失败 40+ 次。

### 2. 幂等判断基于 blob SHA（内容哈希）

状态文件 `.upstream-state.json` 记录上次部署的 `artifactSha`（Git blob SHA，
即内容哈希）。判定逻辑：

| 情况 | blob SHA | 结果 |
|---|---|---|
| 上游仅改名，内容未变 | 不变 | 跳过部署 |
| 上游内容真的更新了 | 改变 | 触发部署 |

这与「跟踪 commit SHA」有本质区别：GitHub 的 `commits?path=X` 会把
*删除该文件* 那次 commit 也算进去，拿到的 SHA 指向一棵 404 的树。

### 3. 失败必须阻断

部署后校验 wrangler 输出中确实包含 `*.pages.dev` 部署 URL，否则
`exit 1`。历史版本的缺陷是：只 `echo` 云端响应体，从不检查
`success` 字段、也不 `exit 1`，于是 Cloudflare 返回
`{"success":false,"errors":[{"code":10405}]}` 时 workflow 依然报 success。

**状态文件只在部署成功后写入**，失败不污染状态，下次调度会重试。

### 4. 内容合理性校验

下载产物后先确认包含 `export default`（worker 入口），再进入打包步骤，
避免把 404 错误页当成产物部署上去。

## 需要的 Secrets

仓库 Secrets（Settings → Secrets and variables → Actions）：

| 名称 | 说明 |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare Account ID |
| `CF_API_TOKEN` | Cloudflare API Token（需 `Account → Cloudflare Pages → Edit`） |

也支持 Global API Key 方式：额外配置 `CF_API_KEY` + `CF_EMAIL`，
脚本会自动优先使用 `CF_API_TOKEN`。

> ⚠️ 历史坑：旧版 workflow 用的 `CF_API_TOKEN` 调用 Worker content 接口时报
> `10405 Method not allowed for this authentication scheme`。改用 wrangler
> 走 Pages 部署后此问题不再出现。

## 手动触发

```bash
gh workflow run auto-deploy.yml --repo lowjh/cfnew
```

或 Actions 页面点 **Run workflow**。

## 脚本

`scripts/sync-deploy.mjs` —— 无第三方依赖，Node 20+ 直接跑。

```bash
CF_ACCOUNT_ID=xxx PAGES_PROJECT=cfnewup-dic node scripts/sync-deploy.mjs
```

## 部署目标说明

| 项 | 值 |
|---|---|
| Cloudflare 类型 | Pages（Direct Upload） |
| Pages 项目名 | `cfnewup-dic` |
| 产物文件 | `_worker.js`（即上游「少年你相信光吗」） |
| 兼容日期 | `2026-01-20` |
| 自定义域名 | `cf.louwh.bond` |
| UUID 路径 | `/louwh` |
