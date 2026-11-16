/**
 * 对 safe-download.js 做源码级安全不变量检查（纯函数，便于单元测试）。
 *
 * 重点：198.18.0.0/15 的“放行”是通过“不再拒绝 198.18/19”实现的，
 * 所以不能只匹配 198.51.100 分支来判断放行是否存在——那会误报。
 */
export function checkSecuritySource(source) {
	const s = String(source ?? '')
	const checks = []
	const add = (name, ok, detail = '') => checks.push({ name, ok: ok === true, detail })

	add('scheme 白名单', /\[\s*['"]http:['"]\s*,\s*['"]https:['"]\s*\]/.test(s))
	add('userinfo 拒绝', /url\.username\s*\|\|\s*url\.password/.test(s))
	add('端口白名单', /url\.port\s*&&\s*!\[\s*['"]80['"]\s*,\s*['"]443['"]\s*\]\.includes/.test(s))
	add('DNS 全量校验', /lookup\(host\s*,\s*\{\s*all:\s*true/.test(s))
	add('DNS 结果全量拒绝', /ipv4\.some\([^)]*!publicIPv4/.test(s))
	add('重定向上限', /maxRedirects/.test(s))
	add('重定向重新解析', /new URL\(location,\s*url\)/.test(s))
	add('大小上限', /maxBytes/.test(s))
	add('超时', /timeoutMs/.test(s))
	add('Content-Length 检查', /content-length/i.test(s))

	// 198.51.100.0/24 必须仍然被拒绝
	const deny51 = /a\s*===\s*198[\s\S]{0,80}?b\s*===\s*51\s*&&\s*c\s*===\s*100/.test(s)
	add('fake-IP：198.51.100 仍拒绝', deny51)

	// 198.18/19 的旧拒绝分支必须已经不存在，才算 198.18.0.0/15 被放行
	const deny18 = /\(a\s*===\s*198\s*&&\s*\(\s*b\s*===\s*18\s*\|\|\s*b\s*===\s*19/.test(s)
	add('fake-IP：198.18/15 已放行', deny51 && !deny18, deny18 ? '仍存在 198.18/19 拒绝分支' : '')

	return { ok: checks.every((c) => c.ok), checks }
}
