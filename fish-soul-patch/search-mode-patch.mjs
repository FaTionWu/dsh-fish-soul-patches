/**
 * fish-soul 补丁：搜索结果两种模式 + 设置页开关。
 *
 * links   ：只把标题/站点/日期/链接给主会话，省 token、避免原文进上下文。
 * summary ：先在一个独立模型调用里做“临时沙箱摘要”，失败/判敏感时降级成 links。
 *
 * 这段逻辑单独成模块，apply-core 调用；data 目录里的 search-mode.js 是运行时实现。
 */
import fs from 'node:fs'
import path from 'node:path'

export function applySearchMode({ lib, patchDir, out }) {
	let ok = true
	let changed = false
	const read = (file) => fs.readFileSync(file, 'utf8')
	const write = (file, text) => { fs.writeFileSync(file, text, 'utf8'); changed = true }
	const replace = (file, oldText, newText, label, marker) => {
		let text = read(file)
		if (text.includes(marker)) { out(`[ok] ${label}: 已经是补丁后的内容`); return }
		if (!text.includes(oldText)) { out(`[!!] ${label}: 找不到锚点`); ok = false; return }
		write(file, text.replace(oldText, newText))
		out(`[done] ${label}: 已打补丁`)
	}

	// 1) 运行时模块
	const dataFile = path.join(patchDir, 'search-mode.js')
	const targetFile = path.join(lib, 'search-mode.js')
	if (!fs.existsSync(dataFile)) { out('[!!] search-mode.js: 缺少补丁数据文件'); return { ok: false, changed } }
	const want = read(dataFile)
	if (fs.existsSync(targetFile) && read(targetFile) === want) out('[ok] search-mode.js: 已经是补丁后的内容')
	else { write(targetFile, want); out('[done] search-mode.js: 已放入') }

	// 2) 配置 schema：tools.web.searchMode，默认 links
	replace(path.join(lib, 'config-schema.js'),
		"\t\t\t\tbaseURL: z.string().default('') // SearXNG 地址",
		"\t\t\t\tbaseURL: z.string().default(''), // SearXNG 地址\n\t\t\t\tsearchMode: z.string().default('links') // links=只给标题+链接（省 token）| summary=临时沙箱摘要（多花 token）",
		'config-schema.js（searchMode）', 'searchMode: z.string()')

	// 3) webSearchConfig 归一化
	replace(path.join(lib, 'websearch.js'),
		"\t\tbaseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\\/+$/, '') : ''",
		"\t\tbaseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\\/+$/, '') : '',\n\t\tsearchMode: raw.searchMode === 'summary' ? 'summary' : 'links'",
		'websearch.js（searchMode）', 'searchMode: raw.searchMode')

	// 4) 搜索摘要模型功能
	replace(path.join(lib, 'llm.js'),
		"\t['mood', '每轮判断心情'],",
		"\t['mood', '每轮判断心情'],\n\t['search', '搜索摘要'],",
		'llm.js（搜索摘要功能）', "['search', '搜索摘要']")

	// 5) webState 返回 searchMode
	replace(path.join(lib, 'routes-v07.js'),
		"\t\t\thasApiKey: w.apiKey !== '', apiKeyMasked: maskKey(w.apiKey), baseURL: w.baseURL,",
		"\t\t\thasApiKey: w.apiKey !== '', apiKeyMasked: maskKey(w.apiKey), baseURL: w.baseURL, searchMode: w.searchMode,",
		'routes-v07.js（web state searchMode）', 'searchMode: w.searchMode')

	// 6) POST /models/config 接受 searchMode
	replace(path.join(lib, 'routes-v07.js'),
		"\t\t\tconst web = { enabled: b.web.enabled === undefined ? cur.enabled : b.web.enabled === true, perDay: Number.isFinite(n) ? Math.min(500, Math.max(0, Math.floor(n))) : cur.perDay };",
		"\t\t\tconst mode = b.web.searchMode === 'summary' || b.web.searchMode === 'links' ? b.web.searchMode : cur.searchMode;\n\t\t\tconst web = { enabled: b.web.enabled === undefined ? cur.enabled : b.web.enabled === true, perDay: Number.isFinite(n) ? Math.min(500, Math.max(0, Math.floor(n))) : cur.perDay, searchMode: mode };",
		'routes-v07.js（保存 searchMode）', 'searchMode: mode')

	// 7) 设置页开关
	const uiRow = [
		'\t\t\t\tRow({ title: "搜到可能敏感的内容时", desc: "链接模式：只给标题和链接，省 token，平台限制内容由你自己点开看；摘要模式：先在一个临时沙箱里做一次安全摘要，多花 token，但信息更完整。摘要被平台拦住时会自动降级成链接。" },',
		'\t\t\t\t\tSeg({ label: "搜索结果模式", value: w.searchMode ?? "links", onChange: (v) => save({ searchMode: v }), options: [',
		'\t\t\t\t\t\t{ value: "links", label: "只给链接（省 token）" }, { value: "summary", label: "沙箱摘要（多花 token）" }',
		'\t\t\t\t\t] })),',
		''
	].join('\n')
	replace(path.join(lib, 'client.models.js'),
		'\t\t\t\town && cur.needsBaseURL ? Row({ title: "SearXNG 地址" },',
		uiRow + '\t\t\t\town && cur.needsBaseURL ? Row({ title: "SearXNG 地址" },',
		'client.models.js（搜索模式开关）', '搜索结果模式')

	// 8) fish_search 所在文件：0.19.2 起拆到 index-tools.js，之前是 index.js
	const toolsFile = path.join(lib, 'index-tools.js')
	const searchFile = fs.existsSync(toolsFile) ? toolsFile : path.join(lib, 'index.js')
	const isTools = searchFile === toolsFile
	let idx = read(searchFile)
	if (idx.includes('formatLinkResults')) {
		out('[ok] index-tools.js/index.js（搜索模式）: 已经是补丁后的内容')
	} else {
		const imp = "import { withSearchRetry } from './search-retry.js';"
		const handler = "\t\t\t\treturn formatSearch(q, await withSearchRetry(() => runWebSearch(q, { signal: toolCtx?.signal }), { signal: toolCtx?.signal }));"
		const modeLine = isTools
			? "\t\t\t\tconst mode = w.searchMode === 'summary' ? 'summary' : 'links';"
			: "\t\t\t\tconst mode = currentConfig.tools?.web?.searchMode === 'summary' ? 'summary' : 'links';"
		const nextHandler = [
			modeLine,
			'\t\t\t\tconst raw = await withSearchRetry(() => runWebSearch(q, { signal: toolCtx?.signal }), { signal: toolCtx?.signal });',
			'\t\t\t\tif (mode === \'links\') return formatLinkResults(q, raw);',
			'\t\t\t\tconst summary = await summarizeSearchResults(q, raw, { callLlm, formatSearch });',
			'\t\t\t\tif (summary !== \'\') return summary;',
			'\t\t\t\treturn `摘要没做成（可能触发了平台限制），改成链接：\\n${formatLinkResults(q, raw)}`;'
		].join('\n')
		if (!idx.includes(imp) || !idx.includes(handler)) { out('[!!] 搜索工具文件（搜索模式）: 找不到 import/调用锚点'); ok = false }
		else {
			idx = idx.replace(imp, imp + "\nimport { formatLinkResults, summarizeSearchResults } from './search-mode.js';")
			idx = idx.replace(handler, nextHandler)
			write(searchFile, idx)
			out(`[done] ${isTools ? 'index-tools.js' : 'index.js'}（搜索模式）: 已打补丁`)
		}
	}

	// 0.19.2 的 fish_search 在 index-tools.js：把 callLlm 从 index.js 传进去
	if (isTools) {
		const idxFile = path.join(lib, 'index.js')
		let it = read(idxFile)
		const depLine = 'gateway, douyinSocial, getConfig, webConfig, ownSearchReady, runWebSearch, formatSearch,'
		if (!/^\s*callLlm,\s*$/m.test(it)) {
			if (it.includes(depLine)) { it = it.replace(depLine, depLine + '\n\t\tcallLlm,'); write(idxFile, it); out('[done] index.js（搜索模式 callLlm）: 已补 deps') }
			else { out('[!!] index.js（搜索模式 callLlm）: 找不到 registerExtraTools deps'); ok = false }
		}
		const tools = read(toolsFile)
		const toolsDep = 'gateway, douyinSocial, getConfig, webConfig, ownSearchReady, runWebSearch, formatSearch,'
		if (!/^\s*callLlm,\s*$/m.test(tools)) {
			if (tools.includes(toolsDep)) { write(toolsFile, tools.replace(toolsDep, toolsDep + '\n\t\tcallLlm,')); out('[done] index-tools.js（搜索模式 callLlm）: 已补 deps') }
			else { out('[!!] index-tools.js（搜索模式 callLlm）: 找不到 deps'); ok = false }
		}
	}

	return { ok, changed }
}
