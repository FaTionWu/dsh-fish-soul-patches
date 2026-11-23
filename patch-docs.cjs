const fs=require('node:fs')
function edit(file, fn){let t=fs.readFileSync(file,'utf8');const n=fn(t);fs.writeFileSync(file,n,'utf8');}
edit('README.md', t=>{
  t=t.replace('10. **Settings UI** — “连续对话（补丁）” under Platform → QQ, and “X 话题（补丁）” under Model → Web\n    Search; plus `GET/POST /patches` and `POST /x-topics/run`.',
  '10. **Settings UI** — “连续对话（补丁）” under Platform → QQ, and “X 话题（补丁）” under Model → Web\n    Search; plus `GET/POST /patches` and `POST /x-topics/run`.\n11. **Search result modes** — default **links-only** (titles/URLs, no raw snippets, low tokens) or\n    **sandbox summary** (one isolated summarizer call first; automatically falls back to links if the\n    platform blocks it). Switch under Model → Web Search.');
  t=t.replace('- **Model → Web Search → X 话题（补丁）**: sources, budget, limits, slots, custom queries, “跑一轮”.',
  '- **Model → Web Search → X 话题（补丁）**: sources, budget, limits, slots, custom queries, “跑一轮”.\n- **Model → Web Search → 搜到可能敏感的内容时**: 链接模式 / 沙箱摘要模式。');
  t=t.replace('dsh-fish-soul@0.18.2` installed','dsh-fish-soul@0.18.22` installed');
  return t;
});
edit('TESTING.md', t=>t.replace('node tests/internal-markup.test.mjs      # system-reminder / DSML / 工具标签不能出现在出站正文','node tests/internal-markup.test.mjs      # system-reminder / DSML / 工具标签不能出现在出站正文\nnode tests/search-mode.test.mjs         # 链接模式不带原文；摘要失败降级 links'));
edit('CHANGELOG.md', t=>t.replace('# Unreleased — 2026-11-23','# Unreleased — 2026-11-23\n\n- 新增搜索结果两模式：links（默认，只给标题/链接，省 token）与 summary（临时沙箱摘要，失败自动降级 links）\n- 设置页 Model → Web Search 增加开关；摘要使用独立 search 模型功能'));
console.log('docs updated')
