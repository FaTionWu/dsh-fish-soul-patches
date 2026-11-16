#!/usr/bin/env node
/**
 * 下载器安全行为测试：
 *   - 真实 HTTP：本地 127.0.0.1 服务必须被拒绝，且请求不会打到服务
 *   - 真实 DNS 路径：默认 lookup 对私有地址直接拒绝
 *   - 注入 lookup/request：验证 fake-IP、混合 DNS、重定向重新校验、userinfo、端口、大小上限
 *
 * 需要已安装/已打补丁的 dsh-fish-soul；通过 DSH_PROFILE_DIR 指定 profile。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const profile = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const file = path.join(profile, 'node_modules', 'dsh-fish-soul', 'lib', 'safe-download.js')
if (!fs.existsSync(file)) {
	console.log(`SKIP  safe-download.js not found at ${file}`)
	process.exit(0)
}

const { createSafeDownload, publicIPv4 } = await import(pathToFileURL(file).href)

// ── 纯函数边界 ────────────────────────────────────────────────
const cases = [
	['198.18.0.143', true], ['198.19.1.1', true], ['198.51.100.1', false],
	['127.0.0.1', false], ['10.1.2.3', false], ['192.168.1.1', false],
	['169.254.1.1', false], ['100.64.0.1', false], ['8.8.8.8', true], ['0.0.0.0', false],
	['224.0.0.1', false], ['::1', false]
]
for (const [ip, want] of cases) assert.equal(publicIPv4(ip), want, `publicIPv4(${ip})`)

// ── 真实 HTTP：127.0.0.1 必须被拒绝，且不产生请求 ──────────────
const server = http.createServer((req, res) => { res.end('secret') })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let hits = 0
server.on('request', () => { hits += 1 })
try {
	const port = server.address().port
	const dl = createSafeDownload()
	const result = await dl(`http://127.0.0.1:${port}/secret`, { maxBytes: 1024 * 1024, timeoutMs: 3000 })
	assert.equal(result, null, 'localhost URL must be rejected')
	assert.equal(hits, 0, 'rejected URL must not reach the local server')
} finally {
	await new Promise((resolve) => server.close(resolve))
}

// ── 注入 DNS/请求：精确控制每个用例 ───────────────────────────
function makeRes(status, headers = {}, chunks = []) {
	return {
		statusCode: status,
		headers,
		destroy() {},
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield Buffer.from(c)
		}
	}
}
function mockRequest(handler) {
	const calls = []
	const request = (url, opts, cb) => {
		calls.push({ url: String(url), opts })
		const res = handler(url, opts, calls.length)
		return {
			once() {},
			end() { queueMicrotask(() => cb(res)) }
		}
	}
	return { request, calls }
}
function mockLookup(rows) {
	return async () => rows
}

// 1) fake-IP 198.18.0.143 允许；连接目标/SNI/Host 必须是原域名
{
	const { request, calls } = mockRequest(() => makeRes(200, { 'content-length': '2' }, ['ok']))
	const dl = createSafeDownload({ lookup: mockLookup([{ address: '198.18.0.143', family: 4 }]), request })
	const buf = await dl('https://multimedia.nt.qq.com.cn/download?a=1', { maxBytes: 1024, timeoutMs: 2000 })
	assert.equal(buf?.toString(), 'ok')
	assert.equal(calls[0].opts.hostname, '198.18.0.143')
	assert.equal(calls[0].opts.headers.host, 'multimedia.nt.qq.com.cn')
	assert.equal(calls[0].opts.servername, 'multimedia.nt.qq.com.cn')
}

// 2) 私有 IP / 混合 DNS：拒绝且不请求
for (const rows of [
	[{ address: '127.0.0.1', family: 4 }],
	[{ address: '10.0.0.1', family: 4 }],
	[{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]
]) {
	const { request, calls } = mockRequest(() => makeRes(200, {}, ['x']))
	const dl = createSafeDownload({ lookup: mockLookup(rows), request })
	assert.equal(await dl('https://example.com/', { maxBytes: 1024, timeoutMs: 2000 }), null)
	assert.equal(calls.length, 0)
}

// 3) 重定向到 127.0.0.1：第二跳重新校验，拒绝
{
	const lookup = async (host) => host === '127.0.0.1'
		? [{ address: '127.0.0.1', family: 4 }]
		: [{ address: '8.8.8.8', family: 4 }]
	const { request, calls } = mockRequest(() => makeRes(302, { location: 'http://127.0.0.1/secret' }))
	const dl = createSafeDownload({ lookup, request })
	assert.equal(await dl('https://example.com/', { maxBytes: 1024, timeoutMs: 2000 }), null)
	assert.equal(calls.length, 1, 'second hop must not be requested')
}

// 4) 重定向到公网：允许，且请求两次
{
	const { request, calls } = mockRequest((url, opts, n) => n === 1
		? makeRes(302, { location: 'https://example.org/final' })
		: makeRes(200, { 'content-length': '2' }, ['ok']))
	const dl = createSafeDownload({ lookup: mockLookup([{ address: '8.8.8.8', family: 4 }]), request })
	const buf = await dl('https://example.com/start', { maxBytes: 1024, timeoutMs: 2000 })
	assert.equal(buf?.toString(), 'ok')
	assert.equal(calls.length, 2)
	assert.equal(calls[1].opts.hostname, '8.8.8.8')
	assert.equal(calls[1].opts.headers.host, 'example.org')
}

// 5) userinfo / 端口 / 协议 / 大小上限
for (const url of ['https://user:pass@example.com/', 'http://example.com:8080/', 'file:///etc/passwd', 'ftp://example.com/']) {
	const { request, calls } = mockRequest(() => makeRes(200, {}, ['x']))
	const dl = createSafeDownload({ lookup: mockLookup([{ address: '8.8.8.8', family: 4 }]), request })
	assert.equal(await dl(url, { maxBytes: 1024, timeoutMs: 2000 }), null, url)
	assert.equal(calls.length, 0, url)
}
{
	const { request } = mockRequest(() => makeRes(200, { 'content-length': '99999' }, ['x']))
	const dl = createSafeDownload({ lookup: mockLookup([{ address: '8.8.8.8', family: 4 }]), request })
	assert.equal(await dl('https://example.com/big', { maxBytes: 10, timeoutMs: 2000 }), null)
}
{
	const { request } = mockRequest(() => makeRes(200, {}, ['1234567890', '1234567890']))
	const dl = createSafeDownload({ lookup: mockLookup([{ address: '8.8.8.8', family: 4 }]), request })
	assert.equal(await dl('https://example.com/big', { maxBytes: 10, timeoutMs: 2000 }), null)
}

// 6) DNS 抛错 / 非法 maxBytes
{
	const dl = createSafeDownload({ lookup: async () => { throw new Error('dns fail') }, request: mockRequest(() => makeRes(200)).request })
	assert.equal(await dl('https://example.com/', { maxBytes: 1024, timeoutMs: 2000 }), null)
	assert.equal(await dl('https://example.com/', { maxBytes: 0, timeoutMs: 2000 }), null)
}

console.log('PASS  download URL/DNS/redirect behavior')
