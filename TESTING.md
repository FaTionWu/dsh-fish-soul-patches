# 测试矩阵

补丁包的测试分三层：**预检/应用/回滚的自动化矩阵**、**文件与模块校验**、**重启后的运行时健康检查**。

## 自动化矩阵

```powershell
node tests/run-matrix.mjs 0.16.6 0.18.2 0.18.9
```

脚本会从 npm 下载对应版本的 `dsh-fish-soul`，解压到临时 profile，逐项执行：

| 场景 | 版本 | 预期结果 |
|------|------|----------|
| 原始版本 | 0.16.6 / 0.18.2 / 0.18.9 | `--check` 通过 → `--apply` 后文件变化 → `--verify` 通过 |
| 已打补丁版本 | 同上 | 第二次 `--apply --no-backup` 幂等，文件 hash 不变 |
| 锚点漂移版本 | 0.18.2（改坏 `persona.js` 锚点） | `--check` 非 0 退出；真实文件 hash 不变（沙箱预检失败，不落盘） |
| 回滚 | 原始包 | `--rollback` 后所有文件 hash 回到原始值，新增的 `lib/x-topics.js` 被删除 |

离线环境可预先把 tarball 放进目录：

```powershell
$env:FISH_SOUL_TARBALL_DIR = "D:\tarballs"   # 文件名 dsh-fish-soul-<version>.tgz
node tests/run-matrix.mjs 0.18.2
```

要求：Node ≥ 22.5、npm、Windows 自带 `tar`（或系统 `tar`）。不需要 GitHub token。

## 文件与模块校验

```powershell
node ./patch-fish-soul.mjs --verify
```

会检查：

- 每个补丁的标记字符串（`fish-soul-patch/patches.json`）；
- 所有被改文件的 `node --check` 语法；
- `safe-download.js` 动态加载 + `publicIPv4` 边界用例；
- `x-topics.js` 动态加载 + 默认查询；
- 下载器安全不变量（scheme / userinfo / 端口 / DNS / 重定向 / 大小 / 超时 / Content-Length / fake-IP 白名单 / 198.51.100 仍拒绝）；
- `soul.db` 的 `x_topic` 表与 `xTopics.*` 计数；
- `fish-soul-config.json` 的 `followup` / `xTopics` / `tools.web` 是否存在。

## 运行时健康检查

```powershell
# 只看模块/DB/配置（不需要 DSH 起来）
node ./patch-fish-soul.mjs --health

# 重启 DSH 后，确认路由真的注册了（需要会话 Cookie 时加上）
node ./patch-fish-soul.mjs --health --url http://127.0.0.1:51374 --cookie "dsh_session=..."
```

`--health` 会：

1. 重新跑标记和模块检查；
2. 检查 `x_topic` 表与计数；
3. 可选的 HTTP 探测：`GET <url>/api/plugins/fish-soul/patches`，返回 JSON 里应包含 `xTopics` / `followup`。没有 Cookie 时可能 401；这是 DSH 的鉴权，不是补丁失败。

## 手动验收清单（重启后）

- [ ] 设置页「平台 → QQ」出现「连续对话（补丁）」，改动后保存成功；
- [ ] 设置页「模型 → 联网搜索」出现「X 话题（补丁）」，能显示今天条数/本月搜索；
- [ ] 点「跑一轮」返回 `stored >= 0`，`x_topic` 表有记录；
- [ ] 聊天里她能提到最近存的话题（瞬态块注入）；
- [ ] `node ./patch-fish-soul.mjs --health` 全部 `[ok]` 或明确的 `[warn]`。

## CI 建议

- 只跑 `--check` 和 `--verify` 需要插件已安装；矩阵测试需要 npm 网络。
- 不要把真实 `~/.dsh` 配置、数据库、Tavily key 放进 CI；矩阵用临时 profile 和临时备份目录。
- 0.18.x 结构变动时，先看 `--check` 是否通过；不通过就不要发布新版本。

## 崩溃恢复与安全行为测试

```powershell
node tests/security-source.test.mjs     # 源码规则 + 反向用例（198.18/15 vs 198.51.100）
node tests/security-download.test.mjs   # 真实本地 HTTP + DNS/重定向/大小/fake-IP 注入用例
node tests/internal-markup.test.mjs      # system-reminder / DSML / 工具标签不能出现在出站正文
node tests/crash-recovery.test.mjs      # SIGKILL 中途写文件 → 下次启动恢复；备份缺失时拒绝部分恢复
```

`run-matrix.mjs` 会在每个版本应用完成后自动跑前两个测试；`crash-recovery` 在 CI 里按版本单独跑。

## GitHub Actions

`.github/workflows/tests.yml` 在 `windows-latest` 上按 0.16.6 / 0.18.2 / 0.18.4 三个版本并行跑：

1. 语法检查；
2. 源码安全规则测试；
3. 完整补丁矩阵（原始 / 已打补丁 / 锚点漂移 / 回滚）；
4. 崩溃恢复测试（SIGKILL + 备份缺失）。

push / PR / 手动触发都会跑；见仓库 Actions 页。