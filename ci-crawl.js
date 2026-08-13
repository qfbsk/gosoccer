/**
 * CI 爬虫：每日重抓所有球员的 /stat 页面，重建 players_stat.js
 * ------------------------------------------------------------------
 * 数据分层（与本地站点一致）：
 *   players_raw.json  - 唯一真源（含球员名单 + 旧 stats，作为抓取源与兜底）
 *   players_stat.js   - 动态统计（技术统计 st + 9维雷达 rd），本脚本每次重写
 *   players_profile.js - 静态档案（本地站点持有，本仓库不碰）
 *
 * 用法（被 GitHub Actions 调用）：node ci-crawl.js
 * 本地手动测试：node ci-crawl.js
 *
 * 抓取策略：
 *   - 读取 players_raw.json 拿到全部球员 slug 列表
 *   - 并发抓取每位球员的 https://www.qiumiwu.com/player/{slug}/stat
 *   - 抓到有效新数据 -> 用新的；抓取失败/数据不足 -> 保留旧 stats（不覆盖）
 *   - 合并写回 players_raw.json（缓存抓取进度，供下次增量）
 *   - 仅重建 players_stat.js（绝不动 profile）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { parseStatHTML } = require('./_parse_stat');
const { compute9DimRadar, DIMS } = require('./_radar_score');

const ROOT = __dirname;
const RAW_FILE = path.join(ROOT, 'players_raw.json');
const STAT_FILE = path.join(ROOT, 'players_stat.js');
const META_FILE = path.join(ROOT, 'meta.json');

const SITE = 'https://www.qiumiwu.com';
const startTime = Date.now();
const CONCURRENCY = 8;     // 并发数
const MAX_RETRY = 4;       // 单球员失败重试次数
const TIMEOUT_MS = 40000;  // 单请求超时
const MIN_KEYS = 12;       // 解析出的 stat 少于这个视为无效

function fetchOne(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': SITE + '/',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let stream = res;
      const ce = res.headers['content-encoding'];
      if (ce === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (ce === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (ce === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, html });
      });
      stream.on('error', e => reject(e));
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(new Error('TIMEOUT')); });
    req.end();
  });
}

async function processTask(task) {
  const url = `${SITE}/player/${task.slug}/stat`;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const { status, html } = await fetchOne(url);
      if (status !== 200) throw new Error('HTTP ' + status);
      const stats = parseStatHTML(html);
      const keys = Object.keys(stats);
      if (keys.length < MIN_KEYS) throw new Error('stat不足(' + keys.length + ')');
      task.ref.stats = stats;
      return { ok: true };
    } catch (e) {
      if (attempt === MAX_RETRY) {
        // 抓取彻底失败：保留旧 stats（raw.json 里已有的），仅标记错误
        task.ref.stats = { __error: e.message };
        return { ok: false, err: e.message };
      }
      await new Promise(r => setTimeout(r, 600 * attempt));
    }
  }
  return { ok: false };
}

// 由 raw.flat 构建 players_stat.js（PLAYERS_STAT[leagueId][teamId][slug] = {st, rd}）
function buildStatJS(raw) {
  const S = { premier_league: {}, la_liga: {} };
  let count = 0;
  for (const p of (raw.flat || [])) {
    const lg = p.leagueId, team = p.teamId;
    const stats = (p.stats && !p.stats.__error) ? p.stats : null;
    if (!stats) continue;
    if (!S[lg]) S[lg] = {};
    if (!S[lg][team]) S[lg][team] = {};
    const r = compute9DimRadar(stats);
    const rd = { avg: r.totalAvg, dims: {} };
    for (const d of DIMS) rd.dims[d.key] = r.result[d.key].score;
    S[lg][team][p.slug] = { st: stats, rd };
    count++;
  }
  const code =
    '// 球员技术统计（动态，CI 每日重写；含实时计算的 9 维雷达 rd）\n' +
    'if (typeof PLAYERS_STAT === "undefined") var PLAYERS_STAT = {};\n' +
    'PLAYERS_STAT = ' + JSON.stringify(S, null, 0) + ';';
  return { code, count };
}

function versionStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

(async () => {
  console.log('读取 players_raw.json ...');
  const raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const flat = raw.flat || [];
  console.log(`总球员数: ${flat.length}`);

  const queue = [];
  for (const p of flat) {
    if (!p.slug) continue;
    queue.push({ slug: p.slug, ref: p });
  }
  console.log(`待抓取: ${queue.length}`);

  let completed = 0, ok = 0, failed = 0;
  let idx = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const i = idx++;
      if (i >= queue.length) break;
      const task = queue[i];
      const r = await processTask(task);
      completed++;
      if (r.ok) ok++; else failed++;
      if (completed % 50 === 0) {
        console.log(`进度 ${completed}/${queue.length}  ok=${ok} fail=${failed}  最新[${task.slug}]`);
      }
    }
  });
  await Promise.all(workers);

  // 写回 raw.json（缓存进度：成功的新数据 & 失败标记都保留）
  fs.writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2), 'utf8');
  console.log(`✓ 已更新 ${path.basename(RAW_FILE)}（ok=${ok} fail=${failed}）`);

  // 重建 players_stat.js
  const { code, count } = buildStatJS(raw);
  fs.writeFileSync(STAT_FILE, code, 'utf8');
  console.log(`✓ 已生成 players_stat.js（含 stat+雷达: ${count} 人）`);

  // 写 meta.json
  const meta = {
    date: new Date().toISOString(),
    version: versionStamp(),
    statChanged: true,
    result: {
      total: flat.length,
      updated: ok,
      keptOld: failed,
      failed,
      elapsedSec: ((Date.now() - startTime) / 1000).toFixed(1),
      statOnly: true,
    },
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf8');
  console.log('✓ 已写 meta.json');
  console.log(`\n全部完成: 完成 ${completed}, ok=${ok}, fail=${failed}`);
})().catch(e => { console.error('CI 抓取失败:', e); process.exit(1); });
