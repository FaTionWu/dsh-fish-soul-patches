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
