#!/usr/bin/env node
/**
 * 源码级安全规则测试（反向用例）：
 *   - 只命中 198.51.100 的拒绝分支，不能算 198.18/15 已放行（之前的正则错误）
 *   - 198.18/19 的旧拒绝分支存在时，放行检查必须失败
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { checkSecuritySource } from '../tools/security-source.mjs'

const patched = `if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname ||
  (url.port && !['80','443'].includes(url.port))) return null;
const addresses = await lookup(host, { all: true, verbatim: true });
if (!ipv4.length || ipv4.some(x => !publicIPv4(x.address))) return null;
if ([301,302,303,307,308].includes(res.statusCode)) { const location = res.headers.location; url = new URL(location, url); }
if (Number.isFinite(declared) && declared > maxBytes) return null;
const signal = AbortSignal.timeout(timeoutMs);
  (a === 198 && b === 51 && c === 100) ||
`

const original = patched.replace(
	'(a === 198 && b === 51 && c === 100) ||',
	'(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||'
)
const only51 = patched
const no51 = patched.replace('(a === 198 && b === 51 && c === 100) ||', '')
const only18 = patched.replace('(a === 198 && b === 51 && c === 100) ||', '(a === 198 && b === 18) ||')

function resultOf(source, name) {
	const r = checkSecuritySource(source)
	const hit = r.checks.find((c) => c.name === name)
	assert.ok(hit, `missing check ${name}`)
	return hit.ok
}

// 1) 正确补丁：放行 198.18/15，仍拒绝 198.51.100
assert.equal(resultOf(patched, 'fake-IP：198.18/15 已放行'), true, 'patched should allow 198.18/15')
assert.equal(resultOf(patched, 'fake-IP：198.51.100 仍拒绝'), true, 'patched should deny 198.51.100')

// 2) 原始版本（198.18/19 仍在拒绝分支里）：不能误报放行
assert.equal(resultOf(original, 'fake-IP：198.18/15 已放行'), false, 'original must NOT be reported as allowed')
assert.equal(resultOf(original, 'fake-IP：198.51.100 仍拒绝'), true, 'original 198.51.100 deny still present')

// 3) 只剩 198.51 拒绝、没有 198.18 允许：放行检查必须失败
assert.equal(resultOf(no51, 'fake-IP：198.18/15 已放行'), false, 'missing 198.51.100 deny must fail allow check')
assert.equal(resultOf(no51, 'fake-IP：198.51.100 仍拒绝'), false)

// 4) 只有 198.51 拒绝（没有 198.18/19 拒绝）：放行通过
assert.equal(resultOf(only51, 'fake-IP：198.18/15 已放行'), true)

// 5) 只有 198.18 拒绝：放行失败
assert.equal(resultOf(only18, 'fake-IP：198.18/15 已放行'), false)

// 6) 可选：对已安装的真实文件跑一次（允许在没装插件时跳过）
const profile = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const real = path.join(profile, 'node_modules', 'dsh-fish-soul', 'lib', 'safe-download.js')
if (fs.existsSync(real)) {
	const r = checkSecuritySource(fs.readFileSync(real, 'utf8'))
	assert.equal(r.ok, true, `installed safe-download.js failed: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`)
	console.log('PASS  source rules (fixtures + installed file)')
} else {
	console.log('PASS  source rules (fixtures; installed file not found, skipped)')
}
