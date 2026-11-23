/**
 * fish-soul 补丁：Content Exists Risk 自动换新会话。
 *
 * 触发后把当前会话标成不可用，下一条消息自动建新会话（记忆在 soul.db 不受影响），
 * 并直接给用户发一条提示，不经过模型。这样一次敏感内容不会把整个聊天永久停死。
 */
import fs from 'node:fs'
import path from 'node:path'

export function applyContentRisk({ lib, patchDir, out }) {
	let ok = true
	let changed = false
	const read = (file) => fs.readFileSync(file, 'utf8')
	const write = (file, text) => { fs.writeFileSync(file, text, 'utf8'); changed = true }
	const replace = (file, oldText, newText, label) => {
		const text = read(file)
		if (!text.includes(oldText)) { out(`[!!] ${label}: 找不到锚点`); ok = false; return false }
		write(file, text.replace(oldText, newText))
		out(`[done] ${label}: 已打补丁`)
		return true
	}

	const dataFile = path.join(patchDir, 'content-risk.js')
	const targetFile = path.join(lib, 'content-risk.js')
	if (!fs.existsSync(dataFile)) { out('[!!] content-risk.js: 缺少补丁数据文件'); return { ok: false, changed } }
	const want = read(dataFile)
	if (fs.existsSync(targetFile) && read(targetFile) === want) out('[ok] content-risk.js: 已经是补丁后的内容')
	else { write(targetFile, want); out('[done] content-risk.js: 已放入') }

	const diagFile = path.join(lib, 'diag-log.js')
	let diag = read(diagFile)
	if (!diag.includes("'session-content-risk'")) {
		const a = "'session-overflow-recycle': '上下文满了，已换新会话',"
		if (!diag.includes(a)) { out('[!!] diag-log.js（内容风控标签）: 找不到锚点'); ok = false }
		else {
			diag = diag.replace(a, "'session-content-risk': '内容触发平台风控，已换新会话',\n'content-risk-recycle': '内容触发平台风控，已换新会话',\n" + a)
			write(diagFile, diag)
			out('[done] diag-log.js（内容风控标签）: 已打补丁')
		}
	} else out('[ok] diag-log.js（内容风控标签）: 已经是补丁后的内容')
	const gwFile = path.join(lib, 'gateway.js')
	let gw = read(gwFile)
	if (gw.includes('CONTENT_RISK_SESSION_KEY')) {
		out('[ok] gateway.js（内容风控自愈）: 已经是补丁后的内容')
		return { ok, changed }
	}

	const imp = "import { stripInternalMarkup } from './internal-markup.js';"
	if (!gw.includes(imp)) { out('[!!] gateway.js（内容风控自愈）: 找不到 internal-markup import'); ok = false }
	else gw = gw.replace(imp, imp + "\nimport { CONTENT_RISK_SESSION_KEY, CONTENT_RISK_NOTICE, isContentRiskReason } from './content-risk.js';")

	const markOld = "\t\tif (this.unusableSessions(SWITCH_BLOCKED_SESSION_KEY).has(id)) return 'switch';\n\t\treturn '';"
	const markNew = "\t\tif (this.unusableSessions(SWITCH_BLOCKED_SESSION_KEY).has(id)) return 'switch';\n\t\tif (this.unusableSessions(CONTENT_RISK_SESSION_KEY).has(id)) return 'content';\n\t\treturn '';"
	if (!gw.includes(markOld)) { out('[!!] gateway.js（内容风控自愈）: unusableKindOf 锚点缺失'); ok = false }
	else gw = gw.replace(markOld, markNew)

	const whyOld = "const why = unusableKind === 'switch' ? '换模型被挡了' : '上下文满了';"
	const whyNew = "const why = unusableKind === 'content' ? '内容触发平台风控' : unusableKind === 'switch' ? '换模型被挡了' : '上下文满了';"
	if (!gw.includes(whyOld)) { out('[!!] gateway.js（内容风控自愈）: why 锚点缺失'); ok = false }
	else gw = gw.replace(whyOld, whyNew)

	const diagOld = "this.diag?.add(unusableKind === 'switch' ? 'session-switch-recycle' : 'session-overflow-recycle', { sessionId: row.session_id, channelId: key }, 'warn');"
	const diagNew = "this.diag?.add(unusableKind === 'content' ? 'session-content-risk-recycle' : unusableKind === 'switch' ? 'session-switch-recycle' : 'session-overflow-recycle', { sessionId: row.session_id, channelId: key }, 'warn');"
	if (!gw.includes(diagOld)) { out('[!!] gateway.js（内容风控自愈）: diag 锚点缺失'); ok = false }
	else gw = gw.replace(diagOld, diagNew)

	const forgetOld = "\t\t\t\tthis.forgetUnusable(row.session_id, OVERFLOW_SESSION_KEY);\n\t\t\t\tthis.forgetUnusable(row.session_id, SWITCH_BLOCKED_SESSION_KEY);"
	const forgetNew = "\t\t\t\tthis.forgetUnusable(row.session_id, OVERFLOW_SESSION_KEY);\n\t\t\t\tthis.forgetUnusable(row.session_id, SWITCH_BLOCKED_SESSION_KEY);\n\t\t\t\tthis.forgetUnusable(row.session_id, CONTENT_RISK_SESSION_KEY);"
	if (!gw.includes(forgetOld)) { out('[!!] gateway.js（内容风控自愈）: forget 锚点缺失'); ok = false }
	else gw = gw.replace(forgetOld, forgetNew)

	const dispatchOld = "\t\t\tconst isOverflow = isContextOverflowReason(errReason);\n\t\t\tconst isSwitchBlocked = isModelSwitchCompactionFailure(errReason);\n\t\t\tif (isOverflow || isSwitchBlocked) {"
	const dispatchNew = "\t\t\tconst isOverflow = isContextOverflowReason(errReason);\n\t\t\tconst isSwitchBlocked = isModelSwitchCompactionFailure(errReason);\n\t\t\tconst isContentRisk = isContentRiskReason(errReason);\n\t\t\tif (isContentRisk) {\n\t\t\t\tconst already = this.unusableKindOf(agent.id) === 'content';\n\t\t\t\tthis.markUnusable(agent.id, CONTENT_RISK_SESSION_KEY);\n\t\t\t\tthis.log('warn', `[fish-soul] 会话 ${agent.id} 触发平台内容风控，下一条消息换新会话`);\n\t\t\t\tthis.diag?.add('session-content-risk', { sessionId: agent.id, channelId: channelId, code: String(errReason.error?.code ?? '') }, 'warn');\n\t\t\t\tif (!already) this.notifyContentRisk(this.bound.get(agent.id)?.channel_id ?? channelId);\n\t\t\t}\n\t\t\tif (isOverflow || isSwitchBlocked) {"
	if (!gw.includes(dispatchOld)) { out('[!!] gateway.js（内容风控自愈）: dispatch 锚点缺失'); ok = false }
	else gw = gw.replace(dispatchOld, dispatchNew)

	const methodAnchor = "\t/** 某类「这条会话不能再用」的会话 id 集合（内存 + kv）。key 区分两类原因。 */"
	const method = "\t/** 内容风控后直接告知用户；不经过模型。 */\n\tnotifyContentRisk(channelId) {\n\t\tconst id = String(channelId ?? '').trim();\n\t\tif (id === '') return;\n\t\ttry { void this.channel?.send(id, [{ type: 'text', data: { text: CONTENT_RISK_NOTICE } }])?.catch?.(() => {}); } catch { /* 发不出去不影响换会话 */ }\n\t}\n\n"
	if (!gw.includes(methodAnchor)) { out('[!!] gateway.js（内容风控自愈）: 方法锚点缺失'); ok = false }
	else gw = gw.replace(methodAnchor, method + methodAnchor)

	const onOld = "\t\t\t\tconst isOverflow = isContextOverflowReason(d.reason);\n\t\t\t\tconst isSwitchBlocked = isModelSwitchCompactionFailure(d.reason);\n\t\t\t\tif (isOverflow || isSwitchBlocked) {"
	const onNew = "\t\t\t\tconst isOverflow = isContextOverflowReason(d.reason);\n\t\t\t\tconst isSwitchBlocked = isModelSwitchCompactionFailure(d.reason);\n\t\t\t\tconst isContentRisk = isContentRiskReason(d.reason);\n\t\t\t\tif (isContentRisk) {\n\t\t\t\t\tconst already = this.unusableKindOf(sessionId) === 'content';\n\t\t\t\t\tthis.markUnusable(sessionId, CONTENT_RISK_SESSION_KEY);\n\t\t\t\t\tthis.log('warn', `[fish-soul] 会话 ${sessionId} 触发平台内容风控，下一条消息换新会话`);\n\t\t\t\t\tthis.diag?.add('session-content-risk', { sessionId, channelId: st.channelId ?? '', code: String(d.reason?.error?.code ?? '') }, 'warn');\n\t\t\t\t\tthis.note('failed', { channelId: st.channelId || ownerKey, reason: '内容触发平台风控（下一条消息换新会话）' });\n\t\t\t\t\tif (!already) this.notifyContentRisk(st.channelId || ownerKey);\n\t\t\t\t}\n\t\t\t\tif (isOverflow || isSwitchBlocked) {"
	if (!gw.includes(onOld)) { out('[!!] gateway.js（内容风控自愈）: turn/end 锚点缺失'); ok = false }
	else gw = gw.replace(onOld, onNew)

	if (ok) { write(gwFile, gw); out('[done] gateway.js（内容风控自愈）: 已打补丁') }
	return { ok, changed }
}
