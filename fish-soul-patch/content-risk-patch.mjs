/**
 * fish-soul 0.19.2+ 补丁：Content Exists Risk 自动换新会话。
 * 0.19.2 拆成 gateway.js / gateway-session.js / gateway-dispatch.js 三个文件。
 */
import fs from 'node:fs'
import path from 'node:path'

export function applyContentRisk({ lib, patchDir, out }) {
	let ok = true
	let changed = false
	const rd = (f) => fs.readFileSync(path.join(lib, f), 'utf8')
	const wr = (f, t) => { fs.writeFileSync(path.join(lib, f), t, 'utf8'); changed = true }
	const replace = (file, oldText, newText, label) => {
		const t = rd(file)
		if (!t.includes(oldText)) { out(`[!!] ${label}: 找不到锚点`); ok = false; return false }
		wr(file, t.replace(oldText, newText)); out(`[done] ${label}: 已打补丁`); return true
	}

	const dataFile = path.join(patchDir, 'content-risk.js')
	const targetFile = path.join(lib, 'content-risk.js')
	if (!fs.existsSync(dataFile)) { out('[!!] content-risk.js: 缺少补丁数据文件'); return { ok: false, changed } }
	const want = fs.readFileSync(dataFile, 'utf8')
	if (fs.existsSync(targetFile) && fs.readFileSync(targetFile, 'utf8') === want) out('[ok] content-risk.js: 已经是补丁后的内容')
	else { wr('content-risk.js', want); out('[done] content-risk.js: 已放入') }

	// diag 标签
	{
		const diagFile = path.join(lib, 'diag-log.js')
		let diag = rd('diag-log.js')
		if (!diag.includes("'session-content-risk'")) {
			const a = "'session-overflow-recycle': '上下文满了，已换新会话',"
			if (!diag.includes(a)) { out('[!!] diag-log.js（内容风控标签）: 找不到锚点'); ok = false }
			else {
				diag = diag.replace(a, "'session-content-risk': '内容触发平台风控，已换新会话',\n'content-risk-recycle': '内容触发平台风控，已换新会话',\n" + a)
				fs.writeFileSync(diagFile, diag, 'utf8'); changed = true; out('[done] diag-log.js（内容风控标签）: 已打补丁')
			}
		} else out('[ok] diag-log.js（内容风控标签）: 已经是补丁后的内容')
	}

	// gateway.js：import、unusableKindOf、通知方法
	{
		let g = rd('gateway.js')
		if (!g.includes("from './content-risk.js'")) {
			const a = "import { stripInternalMarkup } from './internal-markup.js';"
			if (!g.includes(a)) { out('[!!] gateway.js（内容风控自愈）: 找不到 import 锚点'); ok = false }
			else g = g.replace(a, a + "\nimport { CONTENT_RISK_SESSION_KEY, CONTENT_RISK_NOTICE, isContentRiskReason } from './content-risk.js';")
		}
		if (!g.includes('this.unusableSessions(CONTENT_RISK_SESSION_KEY)')) {
			const a = "\t\tif (this.unusableSessions(SWITCH_BLOCKED_SESSION_KEY).has(id)) return 'switch';\n\t\treturn '';"
			if (!g.includes(a)) { out('[!!] gateway.js（内容风控自愈）: unusableKindOf 锚点缺失'); ok = false }
			else g = g.replace(a, "\t\tif (this.unusableSessions(SWITCH_BLOCKED_SESSION_KEY).has(id)) return 'switch';\n\t\tif (this.unusableSessions(CONTENT_RISK_SESSION_KEY).has(id)) return 'content';\n\t\treturn '';")
		}
		if (!g.includes('notifyContentRisk(channelId)')) {
			const a = "\t/** 某类「这条会话不能再用」的会话 id 集合（内存 + kv）。key 区分两类原因。 */"
			if (!g.includes(a)) { out('[!!] gateway.js（内容风控自愈）: 方法锚点缺失'); ok = false }
			else g = g.replace(a, "\t/** 内容风控后直接告知用户；不经过模型。 */\n\tnotifyContentRisk(channelId) {\n\t\tconst id = String(channelId ?? '').trim();\n\t\tif (id === '') return;\n\t\ttry { void this.channel?.send(id, [{ type: 'text', data: { text: CONTENT_RISK_NOTICE } }])?.catch?.(() => {}); } catch { /* 发不出去不影响换会话 */ }\n\t}\n\n" + a)
		}
		wr('gateway.js', g); out('[done] gateway.js（内容风控自愈）: 已处理')
	}

	// gateway-session.js：换会话原因 + 清理内容风控名单
	{
		let s = rd('gateway-session.js')
		if (!s.includes("from './content-risk.js'")) {
			const a = "import { adapterOf } from './douyin-adapter.js';"
			if (!s.includes(a)) { out('[!!] gateway-session.js（内容风控自愈）: 找不到 import 锚点'); ok = false }
			else s = s.replace(a, a + "\nimport { CONTENT_RISK_SESSION_KEY } from './content-risk.js';")
		}
		s = s.replace("const why = unusableKind === 'switch' ? '换模型被挡了' : '上下文满了';", "const why = unusableKind === 'content' ? '内容触发平台风控' : unusableKind === 'switch' ? '换模型被挡了' : '上下文满了';")
		s = s.replace("this.diag?.add(unusableKind === 'switch' ? 'session-switch-recycle' : 'session-overflow-recycle', { sessionId: row.session_id, channelId: key }, 'warn');", "this.diag?.add(unusableKind === 'content' ? 'session-content-risk-recycle' : unusableKind === 'switch' ? 'session-switch-recycle' : 'session-overflow-recycle', { sessionId: row.session_id, channelId: key }, 'warn');")
		s = s.replace(/\t\t\t\tthis\.forgetUnusable\(row\.session_id, OVERFLOW_SESSION_KEY\);\n\t\t\t\tthis\.forgetUnusable\(row\.session_id, SWITCH_BLOCKED_SESSION_KEY\);/g, "\t\t\t\tthis.forgetUnusable(row.session_id, OVERFLOW_SESSION_KEY);\n\t\t\t\tthis.forgetUnusable(row.session_id, SWITCH_BLOCKED_SESSION_KEY);\n\t\t\t\tthis.forgetUnusable(row.session_id, CONTENT_RISK_SESSION_KEY);")
		wr('gateway-session.js', s); out('[done] gateway-session.js（内容风控自愈）: 已处理')
	}

	// gateway-dispatch.js：import、dispatch 失败、turn/end
	{
		let d = rd('gateway-dispatch.js')
		if (!d.includes("from './content-risk.js'")) {
			const a = "import { OVERFLOW_SESSION_KEY, SWITCH_BLOCKED_SESSION_KEY } from './gateway-session.js';"
			if (!d.includes(a)) { out('[!!] gateway-dispatch.js（内容风控自愈）: 找不到 import 锚点'); ok = false }
			else d = d.replace(a, a + "\nimport { CONTENT_RISK_SESSION_KEY, isContentRiskReason } from './content-risk.js';")
		}
		const dispatchOld = "\t\t\tconst isOverflow = isContextOverflowReason(errReason);\n\t\t\tconst isSwitchBlocked = isModelSwitchCompactionFailure(errReason);\n\t\t\tif (isOverflow || isSwitchBlocked) {"
		const dispatchNew = "\t\t\tconst isOverflow = isContextOverflowReason(errReason);\n\t\t\tconst isSwitchBlocked = isModelSwitchCompactionFailure(errReason);\n\t\t\tconst isContentRisk = isContentRiskReason(errReason);\n\t\t\tif (isContentRisk) {\n\t\t\t\tconst already = this.unusableKindOf(agent.id) === 'content';\n\t\t\t\tthis.markUnusable(agent.id, CONTENT_RISK_SESSION_KEY);\n\t\t\t\tthis.log('warn', `[fish-soul] 会话 ${agent.id} 触发平台内容风控，下一条消息换新会话`);\n\t\t\t\tthis.diag?.add('session-content-risk', { sessionId: agent.id, channelId: channelId, code: String(errReason.error?.code ?? '') }, 'warn');\n\t\t\t\tif (!already) this.notifyContentRisk(this.bound.get(agent.id)?.channel_id ?? channelId);\n\t\t\t}\n\t\t\tif (isOverflow || isSwitchBlocked) {"
		if (!d.includes("this.diag?.add('session-content-risk'")) {
			if (!d.includes(dispatchOld)) { out('[!!] gateway-dispatch.js（内容风控自愈）: dispatch 锚点缺失'); ok = false }
			else d = d.replace(dispatchOld, dispatchNew)
		}
		const onOld = "\t\t\t\tconst isOverflow = isContextOverflowReason(d.reason);\n\t\t\t\tconst isSwitchBlocked = isModelSwitchCompactionFailure(d.reason);\n\t\t\t\tif (isOverflow || isSwitchBlocked) {"
		const onNew = "\t\t\t\tconst isOverflow = isContextOverflowReason(d.reason);\n\t\t\t\tconst isSwitchBlocked = isModelSwitchCompactionFailure(d.reason);\n\t\t\t\tconst isContentRisk = isContentRiskReason(d.reason);\n\t\t\t\tif (isContentRisk) {\n\t\t\t\t\tconst already = this.unusableKindOf(sessionId) === 'content';\n\t\t\t\t\tthis.markUnusable(sessionId, CONTENT_RISK_SESSION_KEY);\n\t\t\t\t\tthis.log('warn', `[fish-soul] 会话 ${sessionId} 触发平台内容风控，下一条消息换新会话`);\n\t\t\t\t\tthis.diag?.add('session-content-risk', { sessionId, channelId: st.channelId ?? '', code: String(d.reason?.error?.code ?? '') }, 'warn');\n\t\t\t\t\tthis.note('failed', { channelId: st.channelId || ownerKey, reason: '内容触发平台风控（下一条消息换新会话）' });\n\t\t\t\t\tif (!already) this.notifyContentRisk(st.channelId || ownerKey);\n\t\t\t\t}\n\t\t\t\tif (isOverflow || isSwitchBlocked) {"
		if (!d.includes('if (isContentRisk) {\n\t\t\t\t\tconst already = this.unusableKindOf(sessionId)')) {
			if (!d.includes(onOld)) { out('[!!] gateway-dispatch.js（内容风控自愈）: turn/end 锚点缺失'); ok = false }
			else d = d.replace(onOld, onNew)
		}
		wr('gateway-dispatch.js', d); out('[done] gateway-dispatch.js（内容风控自愈）: 已处理')
	}

	return { ok, changed }
}
