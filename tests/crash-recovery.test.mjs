#!/usr/bin/env node
/**
 * 崩溃事务恢复测试。
 *
 * 模拟：wrapper 建好 pending 恢复点后，apply-core 在写文件途中被 SIGKILL
 * （真实进程终止，不是 try/catch 回滚）。下一次 wrapper 启动必须：
 *   - 发现 pending 事务
 *   - 先验证备份完整
 *   - 恢复全部文件并校验 hash
 *   - 把事务标记为 rolledBack
 *
 * 另测：备份文件缺失时不做任何部分恢复，给出人工恢复指引。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const wrapper = path.join(repo, 'patch-fish-soul.mjs')
const core = path.join(repo, 'apply-core.mjs')
const files = [
	'lib/gateway.js', 'lib/persona.js', 'lib/index.js', 'lib/safe-download.js', 'lib/db.js',
	'lib/config-schema.js', 'lib/websearch.js', 'lib/routes.js', 'lib/client.js', 'lib/client.models.js'
]
const version = process.env.FISH_SOUL_VERSION || '0.18.2'

function run(cmd, args, env = {}, opts = {}) {
	return spawnSync(cmd, args, { encoding: 'utf8', timeout: 10 * 60_000, ...opts, env: { ...process.env, ...env } })
}
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function hashSet(plugin) {
	return Object.fromEntries(files.map((f) => [f, fs.existsSync(path.join(plugin, f)) ? hash(path.join(plugin, f)) : null]))
}
function extract(root) {
	const nm = path.join(root, 'node_modules'); fs.mkdirSync(nm, { recursive: true })
	let tgz = process.env.FISH_SOUL_TARBALL_DIR
		? path.join(process.env.FISH_SOUL_TARBALL_DIR, `dsh-fish-soul-${version}.tgz`)
		: ''
	if (tgz === '' || !fs.existsSync(tgz)) {
		const r = process.platform === 'win32'
			? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm pack dsh-fish-soul@${version}`], {}, { cwd: root })
			: run('npm', ['pack', `dsh-fish-soul@${version}`, '--pack-destination', root], {}, { cwd: root })
		if (r.status !== 0) throw new Error(`npm pack failed: ${r.error?.message ?? r.stderr ?? r.stdout}`)
		tgz = fs.readdirSync(root).filter((f) => f.endsWith('.tgz')).map((f) => path.join(root, f))[0]
	}
	const tr = run('tar', ['-xzf', tgz, '-C', nm])
	if (tr.status !== 0) throw new Error(`tar failed: ${tr.stderr}`)
	fs.renameSync(path.join(nm, 'package'), path.join(nm, 'dsh-fish-soul'))
	return path.join(nm, 'dsh-fish-soul')
}
function wrapperRun(profile, backup, args) {
	const r = run(process.execPath, [wrapper, ...args], { DSH_PROFILE_DIR: profile, FS_PATCH_BACKUP_DIR: backup })
	return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// ── 1) 真实 SIGKILL 后恢复 ─────────────────────────────────────
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-crash-'))
	try {
		const plugin = extract(root)
		const profile = path.join(root, 'profile')
		fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
		fs.renameSync(plugin, path.join(profile, 'node_modules', 'dsh-fish-soul'))
		const backup = path.join(root, 'backups')
		const original = hashSet(path.join(profile, 'node_modules', 'dsh-fish-soul'))

		const b = wrapperRun(profile, backup, ['--backup-only'])
		assert.equal(b.code, 0, b.out)
		const dirs = fs.readdirSync(backup).filter((n) => fs.existsSync(path.join(backup, n, 'manifest.json')))
		assert.equal(dirs.length, 1)
		const id = dirs[0]
		const manifestFile = path.join(backup, id, 'manifest.json')
		assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).status, 'pending')

		// 在写文件途中 SIGKILL（真实进程终止）
		const crash = run(process.execPath, [core], {
			DSH_PROFILE_DIR: profile,
			FS_PATCH_CRASH_AFTER: '3'
		})
		assert.notEqual(crash.status, 0, 'apply-core should be killed')
		const afterCrash = hashSet(path.join(profile, 'node_modules', 'dsh-fish-soul'))
		assert.notDeepEqual(afterCrash, original, 'crash should leave partial changes')
		assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).status, 'pending')

		// 下次启动自动恢复
		const rec = wrapperRun(profile, backup, ['--recover'])
		assert.equal(rec.code, 0, rec.out)
		const recovered = hashSet(path.join(profile, 'node_modules', 'dsh-fish-soul'))
		assert.deepEqual(recovered, original, 'recovery must restore original hashes')
		assert.equal(fs.existsSync(path.join(profile, 'node_modules', 'dsh-fish-soul', 'lib', 'x-topics.js')), false)
		assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).status, 'rolledBack')
	} finally { fs.rmSync(root, { recursive: true, force: true }) }
}

// ── 2) 备份缺失：拒绝部分恢复，给人工指引 ───────────────────────
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-crash-missing-'))
	try {
		const plugin = extract(root)
		const profile = path.join(root, 'profile')
		fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
		fs.renameSync(plugin, path.join(profile, 'node_modules', 'dsh-fish-soul'))
		const backup = path.join(root, 'backups')
		const b = wrapperRun(profile, backup, ['--backup-only'])
		assert.equal(b.code, 0, b.out)
		const id = fs.readdirSync(backup)[0]
		const manifest = JSON.parse(fs.readFileSync(path.join(backup, id, 'manifest.json'), 'utf8'))
		const victim = manifest.files.find((f) => f.existed === true)
		fs.rmSync(path.join(backup, id, 'files', victim.path))

		const target = path.join(profile, 'node_modules', 'dsh-fish-soul', victim.path)
		fs.appendFileSync(target, '\n// simulated partial write\n')
		const before = fs.readFileSync(target)
		const r = wrapperRun(profile, backup, ['--recover'])
		assert.notEqual(r.code, 0, 'missing backup must fail recovery')
		assert.match(r.out, /需要人工恢复/)
		assert.deepEqual(fs.readFileSync(target), before, 'must not partially restore when backup is incomplete')
	} finally { fs.rmSync(root, { recursive: true, force: true }) }
}

console.log('PASS  crash recovery (SIGKILL + missing backup)')
