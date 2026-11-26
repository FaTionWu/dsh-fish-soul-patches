#!/usr/bin/env node
/**
 * patch-fish-soul.mjs — 本地补丁编排器
 *
 * 默认流程：预检（在临时副本里完整跑一遍）→ 备份 → 应用 → 校验；失败自动回滚。
 *
 *   node ./patch-fish-soul.mjs                 # 预检 + 备份 + 应用 + 校验
 *   node ./patch-fish-soul.mjs --check         # 只预检（在沙箱副本里跑，不改真实文件）
 *   node ./patch-fish-soul.mjs --verify        # 只校验已安装状态（文件/模块/安全/DB）
 *   node ./patch-fish-soul.mjs --health        # 运行时健康检查（可选 HTTP 探测）
 *   node ./patch-fish-soul.mjs --rollback      # 回滚最近一次备份
 *   node ./patch-fish-soul.mjs --rollback <id> # 回滚指定备份
 *   node ./patch-fish-soul.mjs --list          # 列出备份
 *
 * 环境变量：
 *   DSH_PROFILE_DIR        DSH profile（默认 ~/.dsh/profiles/desktop）
 *   FS_PATCH_BACKUP_DIR    备份目录（默认 ~/.dsh/fish-soul-patches/backups）
 *   DSH_WEB_URL            可选，运行时健康检查的 DSH 地址（如 http://127.0.0.1:51374）
 *   DSH_COOKIE             可选，探测 /api/plugins/fish-soul/patches 用的 Cookie
 *
 * 补丁本体在 apply-core.mjs；补丁元数据在 fish-soul-patch/patches.json。
 * 本脚本只写 profile 的 node_modules/dsh-fish-soul 和备份目录，不接触配置/数据库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkSecuritySource as checkSecuritySourceText } from './tools/security-source.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const core = path.join(here, 'apply-core.mjs')
const dataDir = path.join(here, 'fish-soul-patch')
const metaFile = path.join(dataDir, 'patches.json')
const profileDir = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const pluginDir = path.join(profileDir, 'node_modules', 'dsh-fish-soul')
const libDir = path.join(pluginDir, 'lib')
const backupRoot = process.env.FS_PATCH_BACKUP_DIR || path.join(os.homedir(), '.dsh', 'fish-soul-patches', 'backups')
const configFile = path.join(os.homedir(), '.dsh', 'fish-soul-config.json')
const soulDb = path.join(os.homedir(), '.dsh', 'fish-soul', 'soul.db')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback = '') => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)

let failed = false
const out = (s = '') => console.log(s)
const warn = (s) => console.log(`[warn] ${s}`)
const bad = (s) => { failed = true; console.log(`[!!] ${s}`) }
const good = (s) => console.log(`[ok] ${s}`)

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\\uFEFF/, '')) } catch { return fallback }
}
function exists(file) { try { return fs.existsSync(file) } catch { return false } }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }) }
function copyFile(src, dst) {
  ensureDir(path.dirname(dst))
  fs.copyFileSync(src, dst)
}
function rmFile(file) {
  try { fs.rmSync(file, { force: true }) } catch { /* ignore */ }
}
function walk(dir, base = '') {
  const result = []
  if (!exists(dir)) return result
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(base, ent.name)
    if (ent.isDirectory()) result.push(...walk(path.join(dir, ent.name), rel))
    else result.push(rel)
  }
  return result
}

function version() {
  const p = readJson(path.join(pluginDir, 'package.json'), {})
  return String(p.version ?? '')
}
function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function satisfies(ver, range) {
  const v = parseVer(ver)
  if (v === null) return false
  for (const part of String(range ?? '').split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(part)
    if (m === null) continue
    const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
    const c = cmp(v, [Number(m[2]), Number(m[3]), Number(m[4])])
    const op = m[1] ?? '='
    if (op === '>=' && c < 0) return false
    if (op === '>' && c <= 0) return false
    if (op === '<=' && c > 0) return false
    if (op === '<' && c >= 0) return false
    if (op === '=' && c !== 0) return false
  }
  return true
}

function loadMeta() {
  const meta = readJson(metaFile, [])
  if (!Array.isArray(meta) || meta.length === 0) return []
  return meta
}

function checkMeta(meta) {
  const ids = new Set(meta.map((p) => p.id))
  for (const p of meta) {
    for (const r of p.requires ?? []) if (!ids.has(r)) bad(`补丁 ${p.id} 依赖不存在的补丁 ${r}`)
    for (const c of p.conflicts ?? []) if (ids.has(c)) bad(`补丁 ${p.id} 与 ${c} 冲突`)
    if (!Array.isArray(p.files) || p.files.length === 0) bad(`补丁 ${p.id} 没有声明文件`)
    if (!Array.isArray(p.markers) || p.markers.length === 0) warn(`补丁 ${p.id} 没有校验标记`)
  }
  return !failed
}

function runNode(file, extraEnv = {}) {
  const r = spawnSync(process.execPath, [file], {
    cwd: here,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 15 * 60_000
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function sandboxCheck(meta) {
  if (!exists(pluginDir)) { bad(`找不到插件：${pluginDir}`); return false }
  if (!exists(core)) { bad(`找不到 apply-core.mjs：${core}`); return false }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-soul-patch-'))
  const tmpProfile = path.join(tmp, 'profile')
  const tmpPlugin = path.join(tmpProfile, 'node_modules', 'dsh-fish-soul')
  try {
    ensureDir(tmpPlugin)
    copyFile(path.join(pluginDir, 'package.json'), path.join(tmpPlugin, 'package.json'))
    for (const rel of walk(libDir)) copyFile(path.join(libDir, rel), path.join(tmpPlugin, 'lib', rel))
    const r = runNode(core, { DSH_PROFILE_DIR: tmpProfile, FS_PATCH_SANDBOX: '1' })
    if (r.code !== 0) {
      bad(`预检失败（沙箱里应用补丁未通过，真实文件未改动）：`)
      for (const line of r.out.split(/\r?\n/).filter(Boolean).slice(-30)) out(`    ${line}`)
      return false
    }
    good('预检通过（沙箱副本完整应用成功）')
    return true
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function backupDirFor(id) { return path.join(backupRoot, id) }
function nextBackupId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  let id = stamp
  let n = 1
  while (exists(backupDirFor(id))) id = `${stamp}-${n++}`
  return id
}

function isOptionalSkipped(p, v = version()) {
  return p.optional === true && !satisfies(v, p.appliesTo)
}

function activeMeta(meta) {
  const v = version()
  return meta.filter((p) => !isOptionalSkipped(p, v))
}
function writeJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

function backup(meta) {
  const id = nextBackupId()
  const dir = backupDirFor(id)
  const files = [...new Set(meta.flatMap((p) => p.files))].sort()
  const manifest = { id, version: version(), profile: profileDir, plugin: pluginDir, createdAt: new Date().toISOString(), status: 'pending', patches: meta.map((p) => p.id), files: [] }
  ensureDir(path.join(dir, 'files'))
  for (const rel of files) {
    const abs = path.join(pluginDir, rel)
    const existed = exists(abs)
    const entry = { path: rel, existed, sha256: null }
    if (existed) {
      const buf = fs.readFileSync(abs)
      entry.sha256 = sha256(buf)
      copyFile(abs, path.join(dir, 'files', rel))
    }
    manifest.files.push(entry)
  }
  writeJson(path.join(dir, 'manifest.json'), manifest)
  good(`已备份 ${manifest.files.length} 个文件 → ${dir}`)
  return id
}

function validateBackup(dir, manifest) {
  const problems = []
  for (const f of manifest.files ?? []) {
    if (f.existed !== true) continue
    const src = path.join(dir, 'files', f.path)
    if (!exists(src)) { problems.push(`缺备份文件：${f.path}`); continue }
    if (f.sha256 !== null && sha256(fs.readFileSync(src)) !== f.sha256) problems.push(`备份哈希不符：${f.path}`)
  }
  return problems
}

function recoveryInstructions(dir, manifest, problems = []) {
  out('')
  out('需要人工恢复。按下面做，不要继续应用补丁：')
  out(`  备份目录：${dir}`)
  out(`  插件目录：${pluginDir}`)
  for (const problem of problems) out(`  - ${problem}`)
  out('  1) 对 manifest.json 里每个 existed=true 的文件：')
  out('     把 <备份目录>/files/<path> 复制回 <插件目录>/<path>')
  out('  2) 对每个 existed=false 的文件：删除 <插件目录>/<path>')
  out('  3) 恢复后按 manifest.json 里的 sha256 校验；全对再重新运行 --check')
  out('')
}

function restoreFromManifest(dir, manifest) {
  const problems = validateBackup(dir, manifest)
  if (problems.length > 0) {
    manifest.status = 'recoveryFailed'
    manifest.recoveryFailedAt = new Date().toISOString()
    manifest.recoveryProblems = problems
    writeJson(path.join(dir, 'manifest.json'), manifest)
    bad(`备份不完整，未做任何恢复（${manifest.id}）`)
    recoveryInstructions(dir, manifest, problems)
    return false
  }
  manifest.status = 'recovering'
  manifest.recoveringAt = new Date().toISOString()
  writeJson(path.join(dir, 'manifest.json'), manifest)
  try {
    for (const f of manifest.files ?? []) {
      const dst = path.join(pluginDir, f.path)
      if (f.existed === true) copyFile(path.join(dir, 'files', f.path), dst)
      else rmFile(dst)
    }
    const bads = []
    for (const f of manifest.files ?? []) {
      const dst = path.join(pluginDir, f.path)
      if (f.existed === true) {
        if (!exists(dst) || (f.sha256 !== null && sha256(fs.readFileSync(dst)) !== f.sha256)) bads.push(`恢复后哈希不一致：${f.path}`)
      } else if (exists(dst)) bads.push(`应删除但仍存在：${f.path}`)
    }
    if (bads.length > 0) throw new Error(bads.join('；'))
    manifest.status = 'rolledBack'
    manifest.rolledBackAt = new Date().toISOString()
    writeJson(path.join(dir, 'manifest.json'), manifest)
    good(`已回滚备份 ${manifest.id}`)
    return true
  } catch (e) {
    manifest.status = 'recoveryFailed'
    manifest.recoveryFailedAt = new Date().toISOString()
    manifest.recoveryError = String(e?.message ?? e)
    writeJson(path.join(dir, 'manifest.json'), manifest)
    bad(`恢复失败：${manifest.recoveryError}`)
    recoveryInstructions(dir, manifest, [manifest.recoveryError])
    return false
  }
}

function restore(id) {
  const dir = backupDirFor(id)
  const manifest = readJson(path.join(dir, 'manifest.json'), null)
  if (manifest === null) { bad(`备份不存在或损坏：${id}`); return false }
  if (manifest.profile !== undefined && manifest.profile !== profileDir) { bad(`这个备份属于另一个 profile：${manifest.profile}`); return false }
  return restoreFromManifest(dir, manifest)
}

/** 启动时恢复所有 pending / recovering 事务（进程被杀、断电后留下的）。 */
function recoverPending() {
  if (!exists(backupRoot)) return true
  let ok = true
  const dirs = fs.readdirSync(backupRoot).filter((n) => exists(path.join(backupRoot, n, 'manifest.json'))).sort()
  for (const id of dirs) {
    const dir = backupDirFor(id)
    const manifest = readJson(path.join(dir, 'manifest.json'), null)
    if (manifest === null) continue
    if (manifest.profile !== undefined && manifest.profile !== profileDir) { warn(`跳过其他 profile 的事务 ${manifest.id}`); continue }
    if (manifest.profile === undefined) { warn(`跳过没有 profile 标记的旧事务 ${manifest.id}`); continue }
    if (manifest.status !== 'pending' && manifest.status !== 'recovering') continue
    out(`发现未完成事务 ${manifest.id}（${manifest.status}），开始恢复…`)
    if (!restoreFromManifest(dir, manifest)) ok = false
  }
  return ok
}

function listBackups() {
  if (!exists(backupRoot)) { out('（还没有备份）'); return }
  const rows = []
  for (const ent of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const m = readJson(path.join(backupRoot, ent.name, 'manifest.json'), null)
    if (m !== null) rows.push({ id: ent.name, at: m.createdAt, status: m.status, version: m.version, files: (m.files ?? []).length })
  }
  rows.sort((a, b) => String(b.id).localeCompare(String(a.id)))
  for (const r of rows) out(`${r.id}  ${r.status}  v${r.version}  ${r.files} files  ${r.at}`)
}

function latestBackup() {
  if (!exists(backupRoot)) return ''
  const ids = fs.readdirSync(backupRoot).filter((n) => exists(path.join(backupRoot, n, 'manifest.json'))).sort()
  return ids.length > 0 ? ids[ids.length - 1] : ''
}

function checkMarkers(meta) {
  for (const p of meta) {
    for (const marker of p.markers ?? []) {
      let found = false
      for (const rel of p.files ?? []) {
        const file = path.join(pluginDir, rel)
        if (!exists(file)) continue
        if (fs.readFileSync(file, 'utf8').includes(marker)) { found = true; break }
      }
      if (!found) bad(`${p.id}: 找不到标记 ${JSON.stringify(marker)}`)
      else good(`${p.id}: ${marker}`)
    }
  }
}

function checkSyntax(meta) {
  const files = [...new Set(meta.flatMap((p) => p.files))].filter((f) => f.endsWith('.js'))
  for (const rel of files) {
    const abs = path.join(pluginDir, rel)
    if (!exists(abs)) {
      if (rel.endsWith('index-tools.js')) warn(`旧版本没有 ${rel}，跳过语法检查`)
      else bad(`缺文件：${rel}`)
      continue
    }
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
    if (r.status === 0) good(`语法：${rel}`)
    else bad(`语法错误：${rel}\n${r.stderr ?? ''}`)
  }
}

async function checkModules() {
  try {
    const sd = await import(pathToFileURL(path.join(libDir, 'safe-download.js')).href)
    const cases = [
      ['198.18.0.143', true], ['198.19.1.1', true], ['198.51.100.1', false],
      ['127.0.0.1', false], ['10.1.2.3', false], ['192.168.1.1', false],
      ['169.254.1.1', false], ['100.64.0.1', false], ['8.8.8.8', true]
    ]
    for (const [ip, want] of cases) {
      const got = sd.publicIPv4(ip)
      if (got === want) good(`安全：publicIPv4(${ip}) = ${got}`)
      else bad(`安全：publicIPv4(${ip}) = ${got}，期望 ${want}`)
    }
  } catch (e) { bad(`safe-download.js 加载失败：${e?.message ?? e}`) }
  try {
    const xt = await import(pathToFileURL(path.join(libDir, 'x-topics.js')).href)
    if (typeof xt.XTopics === 'function') good('模块：XTopics 可加载')
    else bad('模块：XTopics 导出缺失')
    if (Array.isArray(xt.DEFAULT_NEWS_QUERIES) && xt.DEFAULT_NEWS_QUERIES.length > 0) good('模块：默认新闻查询存在')
    else bad('模块：默认新闻查询缺失')
  } catch (e) { bad(`x-topics.js 加载失败：${e?.message ?? e}`) }
}

function checkSecuritySource() {
  const file = path.join(libDir, 'safe-download.js')
  if (!exists(file)) { bad('safe-download.js 不存在'); return }
  const { ok, checks } = checkSecuritySourceText(fs.readFileSync(file, 'utf8'))
  for (const c of checks) {
    if (c.ok) good(`下载器：${c.name}${c.detail ? `（${c.detail}）` : ''}`)
    else bad(`下载器：${c.name}${c.detail ? `（${c.detail}）` : ''}`)
  }
  // 反向断言：不能只命中 198.51.100 就以为 198.18/15 已放行；由 tools 里的 fake-IP 检查负责
  if (ok !== true) failed = true
}

async function checkDbAndConfig() {
  try {
    if (!exists(soulDb)) { warn(`没找到 ${soulDb}，跳过 DB 检查`); return }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(soulDb, { readOnly: true })
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='x_topic'").get()
    if (table) good('DB：x_topic 表存在')
    else bad('DB：x_topic 表不存在')
    const kv = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'xTopics.%'").all()
    if (kv.length > 0) good(`DB：xTopics 计数 ${kv.length} 项`)
    else warn('DB：还没有 xTopics 计数（第一次运行后生成）')
    db.close()
  } catch (e) { warn(`DB 检查失败：${e?.message ?? e}`) }
  try {
    const cfg = readJson(configFile, {})
    const web = cfg.tools?.web ?? {}
    if (web.enabled === true) good(`配置：联网搜索已开（${web.provider ?? 'host'}）`)
    else warn('配置：tools.web.enabled 不是 true')
    if (web.provider && web.provider !== 'host' && !(web.apiKeys?.[web.provider] ?? '')) warn(`配置：${web.provider} 没有 key`)
    if (cfg.followup) good('配置：followup 存在')
    else warn('配置：followup 不存在（会用默认值）')
    if (cfg.xTopics) good('配置：xTopics 存在')
    else warn('配置：xTopics 不存在（功能默认关）')
  } catch (e) { warn(`配置检查失败：${e?.message ?? e}`) }
}

async function verify() {
  failed = false
  const meta = loadMeta()
  if (!checkMeta(meta)) return false
  const v = version()
  out(`\n=== 校验 dsh-fish-soul ${v} @ ${pluginDir} ===`)
  const active = activeMeta(meta)
  for (const p of active) {
    if (!satisfies(v, p.appliesTo)) bad(`${p.id}: 版本 ${v} 不在 ${p.appliesTo}`)
  }
  checkMarkers(active)
  checkSyntax(active)
  await checkModules()
  checkSecuritySource()
  await checkDbAndConfig()
  out(failed ? '\n校验失败。' : '\n校验通过。')
  return !failed
}

async function health() {
  failed = false
  out(`\n=== 运行时健康检查 ===`)
  const meta = activeMeta(loadMeta())
  checkMarkers(meta)
  await checkModules()
  await checkDbAndConfig()
  const url = opt('--url', process.env.DSH_WEB_URL || '')
  const cookie = opt('--cookie', process.env.DSH_COOKIE || '')
  if (url === '') {
    warn('没有提供 DSH_WEB_URL（或 --url），跳过 HTTP 路由探测。')
    warn('提示：设置 DSH_WEB_URL 和 DSH_COOKIE 后，可确认 /api/plugins/fish-soul/patches 是否已注册。')
  } else {
    try {
      const base = url.replace(/\/+$/, '')
      const res = await fetch(`${base}/api/plugins/fish-soul/patches`, { headers: cookie ? { cookie } : {} })
      const text = await res.text()
      if (res.ok && text.includes('"xTopics"')) good(`HTTP：/patches 已注册（${res.status}）`)
      else bad(`HTTP：/patches 返回 ${res.status}，内容里没有 xTopics（可能需要 Cookie，或插件未重启）`)
    } catch (e) { bad(`HTTP 探测失败：${e?.message ?? e}`) }
  }
  out(failed ? '\n健康检查有问题。' : '\n健康检查通过。')
  return !failed
}

function apply(meta) {
  if (!sandboxCheck(meta)) return false
  const active = activeMeta(meta)
  const v = version()
  for (const p of active) {
    if (!satisfies(v, p.appliesTo)) bad(`${p.id}: 版本 ${v} 不在 ${p.appliesTo}（加 --force 也不建议）`)
  }
  if (failed) return false
  const backupId = has('--no-backup') ? '' : backup(active)
  const r = runNode(core, { DSH_PROFILE_DIR: profileDir })
  for (const line of r.out.split(/\r?\n/).filter(Boolean)) out(`    ${line}`)
  if (r.code !== 0) {
    bad('应用失败')
    if (backupId !== '') restore(backupId)
    return false
  }
  if (!verify()) {
    bad('应用后校验失败')
    if (backupId !== '') restore(backupId)
    return false
  }
  if (backupId !== '') {
    const manifestFile = path.join(backupDirFor(backupId), 'manifest.json')
    const m = readJson(manifestFile, {})
    m.status = 'applied'
    m.appliedAt = new Date().toISOString()
    m.after = Object.fromEntries((m.files ?? []).map((f) => [f.path, exists(path.join(pluginDir, f.path)) ? sha256(fs.readFileSync(path.join(pluginDir, f.path))) : null]))
    writeJson(manifestFile, m)
    out(`\n备份 ID：${backupId}`)
    out(`回滚：node ./patch-fish-soul.mjs --rollback ${backupId}`)
  }
  return true
}

async function main() {
  if (has('--help') || has('-h')) {
    out(`用法：
  node ./patch-fish-soul.mjs [--check|--verify|--health|--rollback [id]|--list|--recover]
                              [--url URL] [--cookie COOKIE] [--no-backup]
  node ./patch-fish-soul.mjs --backup-only   # 只建恢复点（测试/手工排查用）

环境：DSH_PROFILE_DIR、FS_PATCH_BACKUP_DIR、DSH_WEB_URL、DSH_COOKIE
`)
    return
  }
  if (has('--list')) { listBackups(); return }
  if (has('--rollback')) {
    const id = opt('--rollback', '') || latestBackup()
    if (id === '') { bad('没有可回滚的备份'); process.exitCode = 1; return }
    process.exitCode = restore(id) ? 0 : 1
    return
  }
  const meta = loadMeta()
  if (!checkMeta(meta)) { process.exitCode = 1; return }
  // 进程被杀 / 断电后留下的 pending / recovering 事务：先恢复，再继续任何检查/应用。
  if (!recoverPending()) { process.exitCode = 1; return }
  if (has('--recover')) { out('未完成事务已处理。'); process.exitCode = failed ? 1 : 0; return }
  if (has('--backup-only')) {
    const id = backup(meta)
    out(`恢复点 ID：${id}（下次运行会自动检测并恢复这个 pending 事务）`)
    process.exitCode = 0
    return
  }
  if (has('--check')) {
    const ok = sandboxCheck(meta)
    process.exitCode = ok ? 0 : 1
    return
  }
  if (has('--verify')) {
    process.exitCode = (await verify()) ? 0 : 1
    return
  }
  if (has('--health')) {
    process.exitCode = (await health()) ? 0 : 1
    return
  }
  const ok = apply(meta)
  process.exitCode = ok ? 0 : 1
}

await main()
