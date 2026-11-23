/** DeepSeek 内容风控导致的失败：这条会话不能再用，下一条消息换新会话。 */
export const CONTENT_RISK_SESSION_KEY = 'session.contentRisk'
export const CONTENT_RISK_NOTICE = '刚才那段内容触发了平台的内容风控，我把会话换新了（记忆还在）。你可以换个说法再发一次。'

export function isContentRiskReason(reason) {
	if (reason === null || typeof reason !== 'object') return false
	if (reason.kind !== 'error') return false
	const err = reason.error ?? {}
	const msg = String(err.message ?? '')
	if (/content\s*exists\s*risk/i.test(msg)) return true
	const code = String(err.code ?? '')
	return code === 'INVALID_REQUEST' && /content.*risk/i.test(msg)
}
