# dsh-fish-soul-patches

**Unofficial experience patches for [dsh-fish-soul](https://github.com/Britneycode/dsh-fish-soul) (MIT).**
**Not affiliated with or endorsed by the upstream author.** Tested against `dsh-fish-soul@0.16.6`, `0.18.2`, `0.18.4`; anchors may break on newer versions. See [TESTING.md](TESTING.md) and [SECURITY.md](SECURITY.md).

[中文说明](#中文说明) · [License](#license--attribution)

---

## What this is

A patch kit, not a fork and not a plugin. It applies a set of anchor-based patches to the installed
`dsh-fish-soul` package inside your DSH profile:

1. **Continuity prompt** — finish unfinished thoughts in the same turn, ask a topic-related follow-up
   instead of ending the conversation.
2. **First-reply delay** — a small 0.6–3 s human-like delay before the first bubble.
3. **No-reply follow-up chain** — after a private chat reply, wait a random 3–9 min; then follow up or
   close. If the first follow-up was a follow-up (not a closing), roll 30 % after 4 min for a second one.
4. **Auto-continue** — when a reply is a flat statement (no question, no explicit closing), optionally
   send one more topic-related line after 3–8 s; cancelled as soon as the user replies.
5. **Reasoning fallback** — if the model puts the whole reply in reasoning and leaves the text empty,
   salvage the last “输出/答案/回复” segment.
6. **Closing-marker handling** — strip and recognize `【收尾】` and bracket variants so the marker never
   leaks to QQ.
7. **QQ text rules** — require the real outgoing text in the reply body, and “finish it this turn”.
8. **Proxy fake-IP allowance** — allow `198.18.0.0/15` (Clash fake-IP) in `safeDownload`, otherwise
   QQ images/CDN downloads are rejected as reserved addresses.
9. **X topics** — a small daily topic source: authoritative X accounts + authoritative news, filtered
   by age/domain/keywords and a monthly search budget. **No X API, no X login**; uses the plugin’s
   configured web search (Tavily/Bocha/host).
10. **Settings UI** — “连续对话（补丁）” under Platform → QQ, and “X 话题（补丁）” under Model → Web
    Search; plus `GET/POST /patches` and `POST /x-topics/run`.

## Requirements

- DSH Desktop with `dsh-fish-soul@0.18.2` installed (the desktop profile is app-managed; install the
  plugin through the DSH plugin manager/market, **not** `dsh plugin --profile desktop ...`).
- Node.js ≥ 22.5.
- Optional: a Tavily API key (free tier, no credit card) for the X topics feature; or Bocha / DSH host
  search.

## Install

```bash
# 1) install dsh-fish-soul@0.18.2 in DSH (plugin manager / market)
# 2) clone or copy this repo anywhere
node ./patch-fish-soul.mjs
```

The script resolves the profile from `DSH_PROFILE_DIR`, or defaults to `~/.dsh/profiles/desktop`.
Expected output: all `[ok]` or `[done]`. If you see `[!!]`, upstream changed the anchor — **do not
force it**; open an issue with the output and your plugin version.

Then **restart DSH** and refresh the settings page (UI chunks are cached by the web client).

Re-running the script is safe (idempotent). Reinstalling/upgrading the plugin wipes the patched files,
so run it again afterwards.

## Safety: preflight, backup, apply, rollback

The entry script is an orchestrator, not a blind patcher:

```powershell
node ./patch-fish-soul.mjs --check     # 只在临时沙箱副本里完整跑一遍，不改真实文件
node ./patch-fish-soul.mjs             # 预检 → 备份 → 应用 → 校验（失败自动回滚）
node ./patch-fish-soul.mjs --verify    # 文件/模块/安全/DB/配置校验
node ./patch-fish-soul.mjs --health    # 运行时健康检查（可选 HTTP 路由探测）
node ./patch-fish-soul.mjs --rollback  # 回滚最近一次
node ./patch-fish-soul.mjs --list      # 列出备份
```

- 预检在临时 profile 副本里完整应用一遍；锚点漂移时直接失败，真实文件不动。
- 应用前把涉及文件备份到 `~/.dsh/fish-soul-patches/backups/<id>/`（记录存在性与 SHA-256）。
- 应用后校验失败会自动回滚；成功会打印备份 ID 和回滚命令。
- 备份可用 `FS_PATCH_BACKUP_DIR` 改位置；`--apply --no-backup` 只推荐在已确认的幂等重跑里用。
- 回滚会恢复所有文件并删除补丁新增的 `lib/x-topics.js`。

## Patch dependencies

| 补丁 | 依赖 | 冲突 | 撤销 |
|------|------|------|------|
| persona-continuity / first-delay / reasoning-fallback / closing-marks | — | — | 从备份恢复对应文件 |
| followup-chain | — | — | 从备份恢复 `gateway.js` |
| auto-continue | followup-chain | — | 从备份恢复 `gateway.js` |
| qq-text-rules | — | — | 从备份恢复 `index.js` |
| safe-download-fake-ip | — | — | 从备份恢复 `safe-download.js` |
| x-topics | qq-text-rules | — | 恢复 `db.js`/`index.js`/`websearch.js`，删除 `x-topics.js` |
| settings-ui | x-topics, followup-chain | — | 恢复 `client.js`/`client.models.js`/`routes.js`/`config-schema.js` |

元数据在 `fish-soul-patch/patches.json`（含适用版本、标记、回滚方式）；脚本会检查依赖/冲突和版本范围。

## Configuration

Patches never overwrite your config. Merge the relevant sections from
`fish-soul-patch/fish-soul-config.example.json` into `~/.dsh/fish-soul-config.json`, or edit them in the
settings UI.

### `followup` — continuity

```json
{
  "enabled": true,
  "minMinutes": 3,
  "maxMinutes": 9,
  "secondMinutes": 4,
  "secondChance": 0.3,
  "autoContinue": { "enabled": true, "chance": 0.45, "cooldownSeconds": 60, "minDelayMs": 3000, "maxDelayMs": 8000 }
}
```

### `xTopics` — daily topics

```json
{
  "enabled": true,
  "sources": ["x", "news"],
  "runsPerDay": 3,
  "newsPerRun": 2,
  "xPerRun": 1,
  "itemsPerDay": 5,
  "maxAgeHours": 48,
  "maxXAgeHours": 168,
  "monthlySearchCap": 280,
  "dailySearchCap": 10,
  "slots": [12, 18, 21],
  "activeHours": [8, 24],
  "queries": [],
  "xQueries": [],
  "newsDomains": [],
  "authorityOnly": true,
  "excludeKeywords": [],
  "share": false,
  "sharePerDay": 1
}
```

Budget: default 3 runs × (2 news + 1 X) = 9 searches/day ≈ 270/month; monthly cap 280, daily cap 10.
Tavily’s free tier is 1,000 credits/month, leaving ~70 % for ad-hoc chat searches.

**Why X + news?** Public search indexes contain X posts that are often days or months old; pure X
cannot reliably produce 3–5 fresh items per day. Set `"sources": ["x"]` if you only want X.

### `tools.web` — web search

```json
{ "enabled": true, "perDay": 20, "provider": "tavily", "apiKeys": { "tavily": "tvly-YOUR_KEY" } }
```

Tavily free tier: 1,000 credits/month, no credit card. Alternatives: `bocha` (domestic, Alipay),
`host` (DSH built-in), `brave`, `searxng`.

## Settings UI

After restarting DSH:

- **Platform → QQ → 连续对话（补丁）**: follow-up window, second follow-up, auto-continue.
- **Model → Web Search → X 话题（补丁）**: sources, budget, limits, slots, custom queries, “跑一轮”.

## Data and files

- Patch entry: `patch-fish-soul.mjs`
- Patch data: `fish-soul-patch/`
- Manifest: `fish-soul-patch/manifest.json`
- Example config: `fish-soul-patch/fish-soul-config.example.json`

New table in `soul.db`: `x_topic`. KV counters: `xTopics.day / dayRuns / daySearches / month /
monthSearches`.

## Updating the plugin

1. Upgrade `dsh-fish-soul` through DSH.
2. Run `node ./patch-fish-soul.mjs`.
3. If everything is `[ok]/[done]`, restart DSH.
4. If an anchor is missing, check the upstream diff; update the data files in `fish-soul-patch/` and the
   corresponding section in `patch-fish-soul.mjs`.

## Limitations & caveats

- Patches modify files inside `node_modules`; a plugin update/reinstall removes them. Keep this repo.
- X topics relies on third-party search indexes; freshness and coverage are limited. It does not call
  the X API and does not log in to X.
- Platform terms (QQ/SnowLuma, Bilibili, Douyin, X, Tavily, Bocha) are the user’s responsibility. Do not
  use this to spam, scrape at scale, or violate rate limits.
- No credentials, cookies, API keys, chat databases, or personal data are included in this repo.

## Security

- Review the patch script before running it; it writes to
  `~/.dsh/profiles/desktop/node_modules/dsh-fish-soul/lib/`.
- Keep your real `fish-soul-config.json`, `soul.db`, `chat-archive.db`, logs and API keys out of git
  (see `.gitignore`).
- The example config contains a placeholder key only.

## License & attribution

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Contains code derived from or excerpted from
[dsh-fish-soul](https://github.com/Britneycode/dsh-fish-soul) (MIT, declared in its `package.json`;
no `LICENSE` file was present in the upstream repository at the time of writing). Original additions in
this repo are Copyright (c) 2026 the patch author.

“dsh-fish-soul” is used only to describe compatibility. All trademarks belong to their respective
owners. This project is **not** an official part of dsh-fish-soul.

---

## 中文说明

这是 [dsh-fish-soul](https://github.com/Britneycode/dsh-fish-soul)（MIT）的**非官方体验补丁包**，不是插件本体，也不包含上游完整源码。测试版本 `0.18.2`，上游改结构后锚点可能失效。

安装：在 DSH 里装好 `dsh-fish-soul@0.18.2`，把本仓库放到任意目录，运行：

```bash
node ./patch-fish-soul.mjs
```

全部 `[ok]/[done]` 后重启 DSH，并刷新设置页。升级插件后需要重跑。设置页会多出「连续对话（补丁）」和「X 话题（补丁）」两个分组；参数也可直接改 `~/.dsh/fish-soul-config.json`。

注意：补丁改的是 `node_modules` 里的文件，重装插件会被清掉；X 话题不调用 X API、不登录 X，走你已配好的联网搜索（Tavily 免费 1000 次/月，或博查/DSH 自带）；不要把真实配置、数据库、日志、API key 提交到 git。

许可见 [LICENSE](LICENSE)、来源与修改说明见 [NOTICE](NOTICE)。非官方项目，与上游作者无隶属或背书关系。
