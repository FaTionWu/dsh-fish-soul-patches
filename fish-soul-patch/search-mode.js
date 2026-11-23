/** 搜索结果输出模式：links（只给链接） / summary（临时沙箱摘要）。 */

/** 链接模式：只给标题、站点、日期和链接，不把原文/snippet 塞进上下文。 */
export function formatLinkResults(query, { results = [] } = {}) {
	const rows = results.slice(0, 6)
	if (rows.length === 0) return `搜「${query}」没搜到东西。`
	const lines = [`搜「${query}」的结果（平台可能限制原文，只给链接；想看细节自己点开）：`]
	rows.forEach((r, i) => {
		const meta = [r.site, r.date].filter(Boolean).join(' ')
		lines.push(`${i + 1}. ${r.title}${meta ? `（${meta}）` : ''}`)
		if (r.url) lines.push(`   ${r.url}`)
	})
	return lines.join('\n')
}

/** 给沙箱摘要模型的指令；不让原文直接进入主会话。 */
export function searchSummaryPrompt(raw) {
	return [
		'你是搜索结果的安全摘要器。下面是从 X/新闻搜到的原始结果。',
		'请输出 2~4 句中文摘要，供聊天回复使用：',
		'- 不要逐字复述原文，不要列链接；',
		'- 涉及政治、冲突、灾难等敏感细节时，只做中性概括，不展开具体人物、指控或口号；',
		'- 如果整段内容几乎都是敏感政治内容，只输出 [LINK_ONLY]；',
		'- 不要编造，不要补充搜索结果里没有的事实。',
		'',
		'搜索结果：',
		String(raw ?? '').slice(0, 4500)
	].join('\n')
}

/** 摘要模式：独立模型调用失败或判敏感时返回 ''，调用方降级成链接。 */
export async function summarizeSearchResults(query, result, { callLlm, formatSearch } = {}) {
	if (typeof callLlm !== 'function' || typeof formatSearch !== 'function') return ''
	try {
		const raw = formatSearch(query, result)
		const out = await callLlm(searchSummaryPrompt(raw), { feature: 'search', maxTokens: 450 })
		const text = String(out ?? '').trim()
		if (text === '' || text.includes('[LINK_ONLY]')) return ''
		const sites = [...new Set((result.results ?? []).map((r) => r.site).filter(Boolean))].slice(0, 3)
		return `搜「${query}」的摘要（已由临时沙箱处理；平台限制的内容不展开）：\n${text.slice(0, 1200)}${sites.length > 0 ? `\n来源：${sites.join('、')}` : ''}`
	} catch {
		return ''
	}
}
