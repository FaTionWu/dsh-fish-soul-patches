/**
 * x-topics.js —— 每天给聊天攒几条「值得聊」的东西。
 *
 * 两条来源，可单独开关：
 *   · x    ：权威机构/媒体的 X 帖子（不碰 X API，用 site:x.com 搜索；推文 id 是
 *            Snowflake，能精确算发布时间，时效不靠搜索服务给不给日期）
 *   · news ：Tavily 的 news 模式（topic=news + days），拿权威媒体最近 1~2 天的报道
 *
 * 为什么不是纯 X：实测公开搜索索引里的 X 权威账号帖子经常是几天甚至几个月前的，
 * 单靠 X 凑不齐「每天 3~5 条 + 有时效」。所以默认 X 优先、news 补足；只想要 X 就把
 * sources 设成 ['x']。
 *
 * 预算：Tavily 免费 1000 次/月。默认每天 3 轮 ×（2 条新闻搜索 + 1 条 X 搜索）= 9 次/天，
 * 月上限 280、日上限 10，留 ~70% 给聊天里临时搜。
 *
 * 产出写 x_topic 表；contextLines() 给上下文当瞬态块（她聊天时自然提）。
 */
import { getKv, setKv } from './db.js';

const SNOWFLAKE_EPOCH = 1288834974657n;
function tweetTimeMs(url) {
	const m = /\/status\/(\d{5,25})/.exec(String(url ?? ''));
	if (!m) return 0;
	try { return Number((BigInt(m[1]) >> 22n) + SNOWFLAKE_EPOCH); } catch { return 0; }
}
function handleOf(url) {
	const m = /(?:^|\/\/)(?:www\.)?x\.com\/([A-Za-z0-9_]{2,30})\//i.exec(String(url ?? ''));
	return m ? m[1] : '';
}
function isAuthorityHost(host) {
	if (AUTHORITY_DOMAINS.has(host)) return true;
	for (const d of AUTHORITY_DOMAINS) if (host.endsWith('.' + d)) return true;
	return false;
}

function hostOf(url) {
	try { return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}
function localDay(ts = Date.now()) {
	return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10);
}
function localMonth(ts = Date.now()) {
	return new Date(ts + 8 * 3600_000).toISOString().slice(0, 7);
}
function oneLine(s, n) {
	const t = String(s ?? '').replace(/\s+/g, ' ').trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
}
const norm = (s) => String(s ?? '').toLowerCase();

/** 默认新闻查询（走 Tavily news 模式）。 */
export const DEFAULT_NEWS_QUERIES = [
	'人工智能 大模型 发布',
	'AI 芯片 半导体 出口管制',
	'美联储 利率 通胀 经济',
	'科技 政策 监管 法案',
	'时政 外交 地缘 联合国',
	'量子计算 航天 生物科技 科研 突破',
	'IMF 世界银行 OECD 经济展望',
	'AI regulation policy',
	'semiconductor export controls',
	'Federal Reserve inflation'
];

/** 默认 X 查询（走普通搜索 + site:x.com）。 */
export const DEFAULT_X_QUERIES = [
	'site:x.com from:OpenAI',
	'site:x.com from:AnthropicAI',
	'site:x.com from:GoogleDeepMind',
	'site:x.com from:NVIDIA',
	'site:x.com from:Microsoft',
	'site:x.com from:Nature',
	'site:x.com from:ScienceMagazine'
];

/** 权威机构 / 媒体的 X 账号（小写比较）。 */
const AUTHORITY = new Set([
	'openai', 'anthropicai', 'googledeepmind', 'deepmind', 'nvidia', 'microsoft', 'apple', 'meta', 'aiatmeta',
	'mistralai', 'huggingface', 'github', 'arxiv', 'nature', 'sciencemagazine', 'mit', 'stanford', 'berkeley',
	'deeplearningai', 'imfnews', 'worldbank', 'federalreserve', 'ecb', 'oecd', 'wef', 'bis_org', 'un', 'who',
	'eu_commission', 'whitehouse', 'statedept', 'xhnews', 'pdchina', 'cgtn', 'chinadaily', 'mfa_china',
	'reuters', 'ap', 'bbcworld', 'ft', 'wsj', 'bloomberg', 'theeconomist', 'nytimes', 'cnbc', 'dw_chinese',
	'nasa', 'esa', 'cern', 'theofficialacm', 'ieee', 'sciam', 'newscientist', 'technologyreview'
]);

/** 权威媒体 / 机构域名（news 来源 + 非 x.com 的 X 搜索结果都认）。 */
const AUTHORITY_DOMAINS = new Set([
	'reuters.com', 'apnews.com', 'ft.com', 'wsj.com', 'bloomberg.com', 'economist.com', 'nytimes.com',
	'bbc.com', 'bbc.co.uk', 'cnbc.com', 'washingtonpost.com', 'cbsnews.com', 'nature.com', 'science.org',
	'sciencedirect.com', 'arxiv.org', 'imf.org', 'worldbank.org', 'federalreserve.gov', 'ecb.europa.eu',
	'oecd.org', 'weforum.org', 'un.org', 'who.int', 'bis.org', 'whitehouse.gov', 'state.gov', 'europa.eu',
	'nasa.gov', 'esa.int', 'cern.ch', 'technologyreview.com', 'spectrum.ieee.org',
	'news.cn', 'xinhuanet.com', 'people.com.cn', 'gov.cn', 'pbc.gov.cn', 'mof.gov.cn', 'ndrc.gov.cn',
	'stats.gov.cn', 'caixin.com', 'gov.cn'
]);

/** 明确不要的：娱乐圈 / 体育赛事 / 八卦。 */
const EXCLUDE = [
	'明星', '综艺', '电影', '电视剧', '演唱会', '选秀', '偶像', '恋情', '八卦', '粉丝',
	'足球', '篮球', 'nba', '世界杯', '奥运', '转会', '比分', '赛季', '英超', '西甲', '中超', '欧冠',
	'celebrity', 'premiere', 'box office', 'transfer', 'matchday', 'touchdown', 'playoff'
];

/** 有价值方向的加分词。 */
const FOCUS = [
	'ai', '人工智能', '大模型', 'llm', '模型', '算法', '芯片', '半导体', '算力', 'gpu',
	'政策', '监管', '法案', '合规', '关税', '出口', '制裁', '央行', '利率', '通胀', '财政', '国债',
	'经济', '市场', '金融', '投资', '基金', '汇率', 'gdp', 'imf', '世界银行', 'oecd',
	'时政', '外交', '地缘', '联合国', '欧盟', '白宫', '国会', '选举', '峰会',
	'科研', '突破', '量子', '航天', '生物', '能源', '气候', '核', '材料',
	'openai', 'anthropic', 'deepmind', 'nvidia', 'microsoft', 'meta', 'apple'
];

const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;

export class XTopics {
	/**
	 * @param {{db:object, getConfig:()=>object, log?:Function, search:(q:string,opts?:object)=>Promise<{results:Array<object>}>, note?:Function, now?:()=>number}} deps
	 */
	constructor({ db, getConfig, log, search, note, now = () => Date.now() }) {
		this.db = db;
		this.getConfig = getConfig;
		this.log = log ?? (() => {});
		this.search = search;
		this.note = note ?? (() => {});
		this.now = now;
		this.timer = null;
		this.running = false;
		this.lastError = '';
		this.lastRunAt = 0;
	}

	cfg() {
		const c = this.getConfig() ?? {};
		const n = (v, d, lo, hi) => {
			const x = Number(v);
			return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.floor(x))) : d;
		};
		const sources = Array.isArray(c.sources) && c.sources.length > 0
			? c.sources.map(String).filter((s) => s === 'x' || s === 'news')
			: ['x', 'news'];
		return {
			enabled: c.enabled === true,
			sources,
			runsPerDay: n(c.runsPerDay, 3, 1, 6),
			newsPerRun: n(c.newsPerRun, 2, 0, 4),
			xPerRun: n(c.xPerRun, 1, 0, 3),
			itemsPerDay: n(c.itemsPerDay, 5, 1, 10),
			maxAgeHours: n(c.maxAgeHours, 48, 1, 24 * 7),
			maxXAgeHours: n(c.maxXAgeHours, 168, 1, 24 * 30),
			monthlySearchCap: n(c.monthlySearchCap, 280, 1, 1000),
			dailySearchCap: n(c.dailySearchCap, 10, 1, 100),
			slots: Array.isArray(c.slots) ? c.slots.map(Number).filter((x) => Number.isFinite(x)).slice(0, 6) : [12, 18, 21],
			activeHours: Array.isArray(c.activeHours) ? c.activeHours.map(Number).slice(0, 2) : [8, 24],
			queries: Array.isArray(c.queries) && c.queries.length > 0 ? c.queries.map(String) : [],
			xQueries: Array.isArray(c.xQueries) && c.xQueries.length > 0 ? c.xQueries.map(String) : [],
			newsDomains: Array.isArray(c.newsDomains) ? c.newsDomains.map(String).filter(Boolean) : [],
			authorityOnly: c.authorityOnly !== false,
			excludeKeywords: Array.isArray(c.excludeKeywords) ? c.excludeKeywords.map(String) : [],
			share: c.share === true,
			sharePerDay: n(c.sharePerDay, 1, 0, 5)
		};
	}

	searchesPerRun(c) {
		const news = c.sources.includes('news') ? c.newsPerRun : 0;
		const x = c.sources.includes('x') ? c.xPerRun : 0;
		return Math.max(1, news + x);
	}

	budget(nowMs = this.now()) {
		const day = localDay(nowMs);
		const month = localMonth(nowMs);
		if (getKv(this.db, 'xTopics.day', '') !== day) {
			setKv(this.db, 'xTopics.day', day);
			setKv(this.db, 'xTopics.dayRuns', 0);
			setKv(this.db, 'xTopics.daySearches', 0);
		}
		if (getKv(this.db, 'xTopics.month', '') !== month) {
			setKv(this.db, 'xTopics.month', month);
			setKv(this.db, 'xTopics.monthSearches', 0);
		}
		return {
			day, month,
			dayRuns: Number(getKv(this.db, 'xTopics.dayRuns', 0)) || 0,
			daySearches: Number(getKv(this.db, 'xTopics.daySearches', 0)) || 0,
			monthSearches: Number(getKv(this.db, 'xTopics.monthSearches', 0)) || 0
		};
	}

	spendSearch(n = 1) {
		const b = this.budget();
		setKv(this.db, 'xTopics.daySearches', b.daySearches + n);
		setKv(this.db, 'xTopics.monthSearches', b.monthSearches + n);
	}

	countToday(day = localDay(this.now())) {
		return Number(this.db.prepare('SELECT COUNT(*) AS n FROM x_topic WHERE day = ?').get(day)?.n ?? 0) || 0;
	}

	status() {
		const c = this.cfg();
		const b = this.budget();
		return {
			enabled: c.enabled, running: this.running, lastRunAt: this.lastRunAt, lastError: this.lastError,
			dayRuns: b.dayRuns, daySearches: b.daySearches, monthSearches: b.monthSearches,
			todayItems: this.countToday(), recent: this.recent(5)
		};
	}

	recent(limit = 8) {
		return this.db.prepare('SELECT url, title, site, author, published_at, snippet, score, seen_at FROM x_topic ORDER BY seen_at DESC LIMIT ?').all(limit);
	}

	/** 聊天用的瞬态块：最近两天的 3~5 条。 */
	contextLines(limit = 4) {
		const rows = this.db.prepare(
			'SELECT url, title, author, site, snippet FROM x_topic WHERE seen_at >= ? ORDER BY seen_at DESC LIMIT ?'
		).all(this.now() - 2 * DAY_MS, Math.max(1, Math.min(6, limit)));
		return rows.map((r) => {
			const who = r.author ? `@${r.author}` : (r.site || 'X');
			return `- ${who}：${oneLine(r.snippet || r.title, 90)}（链接 ${r.url}）`;
		});
	}

	shouldRun(nowMs = this.now()) {
		const c = this.cfg();
		if (!c.enabled) return false;
		const b = this.budget(nowMs);
		if (b.dayRuns >= c.runsPerDay) return false;
		if (b.daySearches + this.searchesPerRun(c) > c.dailySearchCap) return false;
		if (b.monthSearches + this.searchesPerRun(c) > c.monthlySearchCap) return false;
		if (this.countToday(localDay(nowMs)) >= c.itemsPerDay) return false;
		const hour = new Date(nowMs).getHours();
		const [from, to] = c.activeHours;
		if (hour < from || hour >= to) return false;
		const slot = c.slots[Math.min(b.dayRuns, c.slots.length - 1)] ?? 0;
		return hour >= slot;
	}

	start() {
		if (this.running) return;
		this.running = true;
		const tick = async () => {
			if (!this.running) return;
			if (this.shouldRun()) await this.runOnce('schedule').catch((e) => { this.lastError = String(e?.message ?? e); });
			this.timer = setTimeout(tick, 5 * 60_000);
			this.timer.unref?.();
		};
		this.timer = setTimeout(tick, 90_000);
		this.timer.unref?.();
	}

	stop() {
		this.running = false;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	async runNow() {
		return this.runOnce('manual');
	}

	async runOnce(reason = 'schedule') {
		const c = this.cfg();
		if (!c.enabled) return { ok: false, why: 'x 话题关着' };
		const b = this.budget();
		if (this.countToday() >= c.itemsPerDay) return { ok: false, why: '今天的条数够了' };
		if (b.dayRuns >= c.runsPerDay) return { ok: false, why: '今天的轮数够了' };
		const per = this.searchesPerRun(c);
		if (b.daySearches + per > c.dailySearchCap) return { ok: false, why: '今天的搜索预算不够' };
		if (b.monthSearches + per > c.monthlySearchCap) return { ok: false, why: '本月搜索预算不够' };

		const newsAll = c.queries.length > 0 ? c.queries : DEFAULT_NEWS_QUERIES;
		const xAll = c.xQueries.length > 0 ? c.xQueries : DEFAULT_X_QUERIES;
		const jobs = [];
		if (c.sources.includes('news')) {
			const start = (b.dayRuns * c.newsPerRun) % newsAll.length;
			for (let i = 0; i < c.newsPerRun; i++) jobs.push({ kind: 'news', q: newsAll[(start + i) % newsAll.length], opts: { count: 8, topic: 'news', days: 2, ...(c.newsDomains.length > 0 ? { includeDomains: c.newsDomains } : {}) } });
		}
		if (c.sources.includes('x')) {
			const start = (b.dayRuns * c.xPerRun) % xAll.length;
			for (let i = 0; i < c.xPerRun; i++) jobs.push({ kind: 'x', q: xAll[(start + i) % xAll.length], opts: { count: 6 } });
		}

		this.lastRunAt = this.now();
		this.spendSearch(jobs.length);
		const collected = [];
		for (const job of jobs) {
			try {
				const r = await this.search(job.q, job.opts);
				for (const item of r?.results ?? []) {
					const cnd = this.candidate(item, job.q, job.kind, c);
					if (cnd !== null) collected.push(cnd);
				}
			} catch (error) {
				this.lastError = String(error?.message ?? error).slice(0, 160);
				this.log('warn', `[fish-soul] X 话题搜索失败（${job.q}）：${this.lastError}`);
			}
		}

		const picked = this.pick(collected, c);
		const day = localDay(this.now());
		let stored = 0;
		for (const it of picked) {
			if (this.db.prepare('SELECT 1 FROM x_topic WHERE url = ?').get(it.url)) continue;
			if (it.author && this.db.prepare('SELECT 1 FROM x_topic WHERE day = ? AND author = ?').get(day, it.author)) continue;
			this.db.prepare(
				'INSERT OR IGNORE INTO x_topic (url, title, site, author, published_at, snippet, score, query, seen_at, day) VALUES (?,?,?,?,?,?,?,?,?,?)'
			).run(it.url, it.title, it.site, it.author, it.publishedAt, it.snippet, it.score, it.query, this.now(), day);
			stored += 1;
		}
		setKv(this.db, 'xTopics.dayRuns', b.dayRuns + 1);
		if (stored > 0) this.note('x-topics', { title: `X 话题 +${stored}`, text: picked.map((x) => x.title).join(' / ').slice(0, 200), reason: '每天给聊天攒几条话题' });
		return { ok: true, stored, searched: jobs.length, picked: picked.length, reason };
	}

	/** 单条结果 → 候选（不合适的返回 null）。 */
	candidate(item, query, kind, c) {
		const url = String(item?.url ?? '').trim();
		if (!/^https?:\/\//i.test(url)) return null;
		const host = hostOf(url);
		const text = `${item?.title ?? ''} ${item?.snippet ?? ''}`;
		const low = norm(text);
		const exclude = [...EXCLUDE, ...c.excludeKeywords].map(norm).filter(Boolean);
		if (exclude.some((k) => low.includes(k))) return null;

		let publishedAt = 0;
		let author = '';
		let site = host;
		if (kind === 'x') {
			if (host !== 'x.com') return null;
			publishedAt = tweetTimeMs(url);
			if (publishedAt === 0) return null;
			author = handleOf(url);
			const ageH = (this.now() - publishedAt) / HOUR_MS;
			if (ageH < -1 || ageH > c.maxXAgeHours) return null;
			if (c.authorityOnly && !AUTHORITY.has(norm(author))) return null;
		} else {
			if (!isAuthorityHost(host)) return null;
			const t = Date.parse(String(item?.date ?? ''));
			publishedAt = Number.isFinite(t) ? t : 0;
			if (publishedAt === 0) return null;
			const ageH = (this.now() - publishedAt) / HOUR_MS;
			if (ageH < -1 || ageH > c.maxAgeHours) return null;
		}

		let score = 0;
		if (kind === 'x') { score += 3; if (AUTHORITY.has(norm(author))) score += 2; }
		if (kind === 'news') { score += 3; }
		if (FOCUS.some((k) => low.includes(norm(k)))) score += 2;
		const ageH = (this.now() - publishedAt) / HOUR_MS;
		if (ageH <= 24) score += 2;
		else if (ageH <= 72) score += 1;
		if (score < 4) return null;

		return {
			url,
			title: oneLine(item?.title || item?.snippet || url, 140),
			site, author,
			publishedAt: new Date(publishedAt).toISOString(),
			snippet: oneLine(item?.snippet || item?.title || '', 300),
			score, query
		};
	}

	/** 去重、按分排序、限制条数和来源/作者多样性。 */
	pick(list, c) {
		const seen = new Set();
		const byKey = new Map();
		const items = [];
		const cap = Math.min(c.itemsPerDay - this.countToday(), Math.max(1, Math.ceil(c.itemsPerDay / c.runsPerDay)));
		for (const it of [...list].sort((a, b) => b.score - a.score)) {
			if (seen.has(it.url)) continue;
			seen.add(it.url);
			const key = it.author ? `a:${it.author}` : `s:${it.site}`;
			const n = byKey.get(key) ?? 0;
			if (n >= 1) continue;
			byKey.set(key, n + 1);
			items.push(it);
			if (items.length >= cap) break;
		}
		return items;
	}
}
