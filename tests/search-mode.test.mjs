#!/usr/bin/env node
/** 搜索结果两种模式：链接省 token；沙箱摘要失败降级。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const profile = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const file = path.join(profile, 'node_modules', 'dsh-fish-soul', 'lib', 'search-mode.js')
if (!fs.existsSync(file)) { console.log(`SKIP  not found: ${file}`); process.exit(0) }
const { formatLinkResults, searchSummaryPrompt, summarizeSearchResults } = await import(pathToFileURL(file).href)

const result = { results: [
	{ title: '某条 X 热帖', site: 'x.com', date: '2026-11-23', url: 'https://x.com/a/1', snippet: '敏感原文不应出现' },
	{ title: '新闻标题', site: 'reuters.com', date: '2026-11-23', url: 'https://reuters.com/x', snippet: '新闻摘要' }
] }
const links = formatLinkResults('今天的大事', result)
assert.match(links, /只给链接/)
assert.match(links, /某条 X 热帖/)
assert.match(links, /https:\/\/x\.com\/a\/1/)
assert.doesNotMatch(links, /敏感原文不应出现/)
assert.doesNotMatch(links, /新闻摘要/)

assert.match(searchSummaryPrompt('raw'), /不要逐字复述原文/)
assert.match(searchSummaryPrompt('raw'), /\[LINK_ONLY\]/)

let calls = 0
const ok = await summarizeSearchResults('q', result, {
	formatSearch: () => '原始结果',
	callLlm: async () => { calls += 1; return '这是安全摘要。' }
})
assert.equal(calls, 1)
assert.match(ok, /安全摘要/)
assert.doesNotMatch(ok, /敏感原文不应出现/)
assert.match(ok, /来源：x\.com/)

const linkOnly = await summarizeSearchResults('q', result, { formatSearch: () => 'x', callLlm: async () => '[LINK_ONLY]' })
assert.equal(linkOnly, '')
const failed = await summarizeSearchResults('q', result, { formatSearch: () => 'x', callLlm: async () => { throw new Error('Content Exists Risk') } })
assert.equal(failed, '')
console.log('PASS  search mode links/summary fallback')
