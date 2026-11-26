import fs from 'node:fs'
import path from 'node:path'

/** 0.19.2+：sendReply 抛错/返回失败时，直接用已生成正文走 QQ 通道直发，避免静默丢回复。 */
export function applySendFallback({ lib, out }) {
	const file = path.join(lib, 'gateway-dispatch.js')
	let t = fs.readFileSync(file, 'utf8')
	if (t.includes('send-reply-fallback')) { out('[ok] gateway-dispatch.js（发送兜底）: 已经是补丁后的内容'); return { ok: true } }
	let ok = true
	const imp = "import { CONTENT_RISK_SESSION_KEY, isContentRiskReason } from './content-risk.js';"
	if (!t.includes("from './internal-markup.js'")) {
		if (!t.includes(imp)) { out('[!!] gateway-dispatch.js（发送兜底）: 找不到 import 锚点'); ok = false }
		else t = t.replace(imp, imp + "\nimport { stripInternalMarkup } from './internal-markup.js';")
	}
	const old = "\t\t\tvoid this.sendReply(sessionId, st).then((ok) => {\n\t\t\t\tsettle(ok === true, ok === true ? '' : '回复没发出去（发送失败）');\n\t\t\t}, (error) => {\n\t\t\t\tthis.log('error', `[fish-soul] 回复发出去失败：${String(error instanceof Error ? error.message : error)}`);\n\t\t\t\tsettle(false, `回复没发出去：${String(error instanceof Error ? error.message : error).slice(0, 150)}`);\n\t\t\t});"
	const neu = "\t\t\tvoid this.sendReply(sessionId, st).then((ok) => {\n\t\t\t\tif (ok !== true) {\n\t\t\t\t\tconst ch = this.bound.get(sessionId)?.channel_id ?? st.channelId ?? '';\n\t\t\t\t\tconst text = stripInternalMarkup(String(st.text ?? '')).trim();\n\t\t\t\t\tif (ch !== '' && text !== '') void this.channel?.send(ch, [{ type: 'text', data: { text } }]).then(() => {\n\t\t\t\t\t\tthis.diag?.add('send-reply-fallback', { sessionId, channelId: ch, textLen: text.length }, 'warn');\n\t\t\t\t\t}).catch((e) => this.diag?.add('send-reply-fallback-failed', { sessionId, channelId: ch, reason: String(e instanceof Error ? e.message : e).slice(0, 200) }, 'warn'));\n\t\t\t\t}\n\t\t\t\tsettle(ok === true, ok === true ? '' : '回复没发出去（发送失败）');\n\t\t\t}, (error) => {\n\t\t\t\tconst msg = String(error instanceof Error ? error.message : error);\n\t\t\t\tthis.log('error', `[fish-soul] 回复发出去失败：${msg}`);\n\t\t\t\tthis.diag?.add('send-reply-error', { sessionId, reason: msg.slice(0, 200), textLen: String(st.text ?? '').length, bound: this.bound.has(sessionId) }, 'warn');\n\t\t\t\tconst ch = this.bound.get(sessionId)?.channel_id ?? st.channelId ?? '';\n\t\t\t\tconst text = stripInternalMarkup(String(st.text ?? '')).trim();\n\t\t\t\tif (ch !== '' && text !== '') void this.channel?.send(ch, [{ type: 'text', data: { text } }]).then(() => {\n\t\t\t\t\tthis.diag?.add('send-reply-fallback', { sessionId, channelId: ch, textLen: text.length }, 'warn');\n\t\t\t\t}).catch((e) => this.diag?.add('send-reply-fallback-failed', { sessionId, channelId: ch, reason: String(e instanceof Error ? e.message : e).slice(0, 200) }, 'warn'));\n\t\t\t\tsettle(false, `回复没发出去：${msg.slice(0, 150)}`);\n\t\t\t});"
	if (!t.includes(old)) { out('[!!] gateway-dispatch.js（发送兜底）: 找不到 sendReply 锚点'); ok = false }
	else t = t.replace(old, neu)
	if (ok) { fs.writeFileSync(file, t, 'utf8'); out('[done] gateway-dispatch.js（发送兜底）: 已打补丁') }
	return { ok }
}
