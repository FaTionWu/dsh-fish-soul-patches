# Unreleased — 2026-11-23

- 适配 dsh-fish-soul 0.18.22（dispatch 增加 opts，锚点兼容）；矩阵通过，备份 ID 20261122162807

- 适配 dsh-fish-soul 0.18.14；矩阵通过，补丁备份 ID 20261120055804

- fish_search 网络失败（fetch failed / 5xx）自动重试一次；4xx 和外部取消不重试

# v0.2.1 — 2026-11-18

支持 dsh-fish-soul 0.18.9；CI（0.16.6 / 0.18.2 / 0.18.9）全绿：
https://github.com/FaTionWu/dsh-fish-soul-patches/actions/runs/44328898298

- 适配 dsh-fish-soul 0.18.7：gateway-util import 改为正则匹配（上游新增 normalizeRelayId）
- 0.18.7 矩阵通过（原始/已打补丁/漂移/回滚）
- 0.18.9 矩阵通过；补丁备份 ID 20261118143749

- 出站剥离 system-reminder / DSML / 工具调用标签，防止内部内容发到 QQ
- 新增 internal-markup 补丁与回归测试

# v0.2.0 — 2026-11-17

首个带安全加固与 CI 的版本。CI（Windows，0.16.6 / 0.18.2 / 0.18.4）全绿：
https://github.com/FaTionWu/dsh-fish-soul-patches/actions/runs/43928682660

## 2026-11-17 — crash recovery + security tests + CI

- Fixed false-positive in security source regex (198.18/15 vs 198.51.100)
- Added reverse fixtures for security source rules
- Added pending-transaction recovery: validate backup, restore, verify hashes, manual instructions
- Added SIGKILL mid-apply recovery test and missing-backup test
- Added real localhost HTTP + injected DNS/redirect/size security behavior tests
- Added GitHub Actions matrix for 0.16.6 / 0.18.2 / 0.18.4
## 2026-11-17 — safety/test hardening

- Orchestrator: sandbox preflight, backup, apply, verify, automatic rollback
- `--check / --verify / --health / --rollback / --list` commands
- Patch metadata with dependencies, conflicts, applicable versions, rollback
- Test matrix: original / patched / anchor-drift, plus rollback and idempotence
- Security audit: downloader URL/redirect/fake-IP invariants and boundary tests
- Runtime health: module load, DB table, config, optional `/patches` HTTP probe
- Tested on 0.16.6, 0.18.2, 0.18.4
# Changelog

## 2026-11-17 — initial public draft

- Continuity prompt patches (finish thoughts in the same turn, topic-aware follow-ups)
- First-reply delay
- No-reply follow-up chain (3–9 min random, 30 % second follow-up after 4 min)
- Auto-continue for flat replies (3–8 s, probability + cooldown)
- Reasoning fallback and closing-marker handling
- QQ text rules
- safeDownload fake-IP allowance (198.18.0.0/15)
- Daily X topics (authoritative X accounts + authoritative news, budgeted search)
- Settings UI groups and `/patches` routes
- Patch kit documentation, manifest, example config
