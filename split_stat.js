#!/usr/bin/env node
/**
 * split_stat.js
 * --------------------------------------------------------------------------
 * 从整包 players_stat.js 切出两个联赛分片，供前端按需加载。
 * 与 ci-crawl.js 解耦：整包由 ci-crawl.js 生成，本脚本仅做 post-process。
 *
 * 输出风格与 players_stat.js 一致（"var PLAYERS_STAT 守卫 + 赋值"），
 * 但只赋自己联赛的 key，保证两个分片按任意顺序加载都不会互相覆盖：
 *   players_stat_pl.js  -> 仅含 premier_league
 *   players_stat_ll.js  -> 仅含 la_liga
 *
 * 用法：node split_stat.js
 *   被 .github/workflows/daily-crawl.yml 在生成 players_stat.js 之后调用
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const STAT_FILE = path.join(ROOT, 'players_stat.js');

if (!fs.existsSync(STAT_FILE)) {
  console.error('[split_stat] 找不到 ' + STAT_FILE + '，请先跑 ci-crawl.js 生成整包');
  process.exit(1);
}

// 读整包。原始写法是：
//   if (typeof PLAYERS_STAT === "undefined") var PLAYERS_STAT = {};
//   PLAYERS_STAT = { ... };
// 在 vm.runInContext 里：`var PLAYERS_STAT` 会成为 ctx 的属性（var hoisting），
// 第二行赋新值同样写到 ctx.PLAYERS_STAT 上，直接读 ctx.PLAYERS_STAT 即可。
const src = fs.readFileSync(STAT_FILE, 'utf8');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const S = ctx.PLAYERS_STAT;
if (!S || typeof S !== 'object') {
  console.error('[split_stat] 解析 players_stat.js 失败（未拿到 PLAYERS_STAT）');
  process.exit(1);
}

function emit(lg, otherSuffix, outName) {
  if (!S[lg]) {
    console.warn('[split_stat] 整包不含 ' + lg + '，跳过 ' + outName);
    return;
  }
  const code =
    '// 球员技术统计（按联赛切分；CI 每日刷新时由 split_stat.js 从整包切出）\n' +
    '// 仅含 ' + lg + '，另一联赛见 players_stat_' + otherSuffix + '.js\n' +
    'if (typeof PLAYERS_STAT === "undefined") var PLAYERS_STAT = {};\n' +
    'PLAYERS_STAT["' + lg + '"] = ' + JSON.stringify(S[lg]) + ';\n';
  const outPath = path.join(ROOT, outName);
  fs.writeFileSync(outPath, code, 'utf8');
  const sz = fs.statSync(outPath).size;
  console.log('[split_stat] ' + outName + '  (' + (sz / 1024 / 1024).toFixed(2) + ' MB,  ' + lg + ')');
}

emit('premier_league', 'll', 'players_stat_pl.js');
emit('la_liga', 'pl', 'players_stat_ll.js');
console.log('[split_stat] 完成');
