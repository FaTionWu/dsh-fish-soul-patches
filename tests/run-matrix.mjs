#!/usr/bin/env node
/**
 * 补丁矩阵测试：原始版本 / 已打补丁 / 锚点漂移。
 *
 *   node tests/run-matrix.mjs [版本...]
 *
 * 默认测 0.18.2 和 0.18.4；每个版本都会：
 *   1) 从 npm 下载 tarball → 解压到临时 profile
 *   2) --check 预检
 *   3) --apply 应用 → --verify 校验
 *   4) 再 apply 一次，确认幂等（hash 不变）
 *   5) --rollback，确认恢复成原始 hash、新增文件被删除
 *   6) 另拷一份原始包，改坏一个锚点，确认 --check 失败且真实文件未变
 *
 * 需要网络（npm）和 Windows 自带 tar；CI 里可预先把 tarball 放进
 * FISH_SOUL_TARBALL_DIR（文件名 dsh-fish-soul-<version>.tgz）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const wrapper = path.join(repo, 'patch-fish-soul.mjs')
const versions = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['0.18.2', '0.18.4']
const files = [
	'lib/gateway.js', 'lib/persona.js', 'lib/index.js', 'lib/safe-download.js', 'lib/db.js',
	'lib/config-schema.js', 'lib/websearch.js', 'lib/routes.js', 'lib/client.js', 'lib/client.models.js'
]
const results = []

function run(cmd, args, opts = {}) {
	return spawnSync(cmd, args, { encoding: 'utf8', timeout: 20 * 60_000, ...opts })
}
function hashFile(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function hashSet(root) {
	return Object.fromEntries(files.map((f) => [f, fs.existsSync(path.join(root, f)) ? hashFile(path.join(root, f)) : null]))
}
function sameHash(a, b) {
	return JSON.stringify(a) === JSON.stringify(b)
}
function extract(version, root) {
	const nm = path.join(root, 'node_modules')
	fs.mkdirSync(nm, { recursive: true })
	let tgz = process.env.FISH_SOUL_TARBALL_DIR
		? path.join(process.env.FISH_SOUL_TARBALL_DIR, `dsh-fish-soul-${version}.tgz`)
		: ''
	if (tgz === '' || !fs.existsSync(tgz)) {
		const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
		const r = process.platform === 'win32'
			? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm pack dsh-fish-soul@${version}`], { cwd: root })
			: run(npm, ['pack', `dsh-fish-soul@${version}`, '--pack-destination', root], { cwd: root })
		if (r.status !== 0) throw new Error(`npm pack ${version} 失败：${r.error?.message ?? r.stderr ?? r.stdout}`)
		tgz = fs.readdirSync(root).filter((f) => f.endsWith('.tgz')).map((f) => path.join(root, f))[0]
	}
	const tr = run('tar', ['-xzf', tgz, '-C', nm])
	if (tr.status !== 0) throw new Error(`解压失败：${tr.stderr}`)
	fs.renameSync(path.join(nm, 'package'), path.join(nm, 'dsh-fish-soul'))
	return path.join(nm, 'dsh-fish-soul')
}

function runPatch(profile, backup, args) {
	const r = run(process.execPath, [wrapper, ...args], {
		cwd: repo,
		env: { ...process.env, DSH_PROFILE_DIR: profile, FS_PATCH_BACKUP_DIR: backup }
	})
	return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function testVersion(version) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `fs-matrix-${version}-`))
	const backup = path.join(root, 'backups')
	try {
		const plugin = extract(version, root)
		const lib = path.join(plugin, 'lib')
		const original = hashSet(plugin)
		const profile = path.join(root, 'profile')
		fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
		// plugin 已经被 extract 到 root/node_modules，profile 指向 root
		const profilePlugin = path.join(profile, 'node_modules', 'dsh-fish-soul')
		fs.mkdirSync(path.dirname(profilePlugin), { recursive: true })
		fs.renameSync(plugin, profilePlugin)
		const plib = path.join(profilePlugin, 'lib')

		const check = runPatch(profile, backup, ['--check'])
		if (check.code !== 0) throw new Error(`--check 失败\n${check.out.slice(-2000)}`)

		const apply1 = runPatch(profile, backup, ['--apply'])
		if (apply1.code !== 0) throw new Error(`--apply 失败\n${apply1.out.slice(-2000)}`)
		const applied = hashSet(profilePlugin)
		if (sameHash(original, applied)) throw new Error('应用后文件没有变化')

		const verify1 = runPatch(profile, backup, ['--verify'])
		if (verify1.code !== 0) throw new Error(`--verify 失败\n${verify1.out.slice(-2000)}`)

		const apply2 = runPatch(profile, backup, ['--apply', '--no-backup'])
		if (apply2.code !== 0) throw new Error(`第二次 --apply 失败\n${apply2.out.slice(-2000)}`)
		const reapplied = hashSet(profilePlugin)
		if (!sameHash(applied, reapplied)) throw new Error('第二次 apply 不是幂等的（hash 变了）')

		const rollback = runPatch(profile, backup, ['--rollback'])
		if (rollback.code !== 0) throw new Error(`--rollback 失败\n${rollback.out.slice(-2000)}`)
		const restored = hashSet(profilePlugin)
		if (!sameHash(original, restored)) throw new Error('回滚后 hash 和原始不一致')
		if (fs.existsSync(path.join(plib, 'x-topics.js'))) throw new Error('回滚后 x-topics.js 还在')

		// 锚点漂移：重新解一份原始包，改坏 persona 锚点
		const driftRoot = fs.mkdtempSync(path.join(os.tmpdir(), `fs-drift-${version}-`))
		const driftPlugin = extract(version, driftRoot)
		const driftProfile = path.join(driftRoot, 'profile')
		fs.mkdirSync(path.join(driftProfile, 'node_modules'), { recursive: true })
		fs.renameSync(driftPlugin, path.join(driftProfile, 'node_modules', 'dsh-fish-soul'))
		const driftLib = path.join(driftProfile, 'node_modules', 'dsh-fish-soul', 'lib')
		const persona = path.join(driftLib, 'persona.js')
		const text = fs.readFileSync(persona, 'utf8')
		const mutated = text.replace('话说完了就停，不用每条结尾都递个问题', '（测试：锚点被上游改写）')
		if (mutated === text) throw new Error('漂移测试找不到 persona 锚点')
		fs.writeFileSync(persona, mutated)
		const beforeDrift = hashSet(path.join(driftProfile, 'node_modules', 'dsh-fish-soul'))
		const driftCheck = runPatch(driftProfile, path.join(driftRoot, 'backups'), ['--check'])
		const afterDrift = hashSet(path.join(driftProfile, 'node_modules', 'dsh-fish-soul'))
		if (driftCheck.code === 0) throw new Error('锚点漂移时 --check 仍然成功（应该失败）')
		if (!sameHash(beforeDrift, afterDrift)) throw new Error('锚点漂移失败后真实文件被改动')
		fs.rmSync(driftRoot, { recursive: true, force: true })
		return { version, ok: true }
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
}

for (const v of versions) {
	try {
		results.push(testVersion(v))
		console.log(`PASS  ${v}`)
	} catch (e) {
		results.push({ version: v, ok: false, error: String(e?.message ?? e) })
		console.log(`FAIL  ${v}\n${String(e?.message ?? e).split(/\r?\n/).slice(0, 12).join('\n')}`)
	}
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length === 0 ? 0 : 1
