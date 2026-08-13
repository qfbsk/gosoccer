// 解析 /player/{slug}/stat 页面HTML → {statName: {value:number, rank:number}}
function parseStatHTML(html) {
  const out = {};
  // 匹配 <a class="stat__list" 或 <div class="stat__list" ...> ... </a|/div>
  // 用正则切分：找到所有 stat__list 块
  const re = /<(a|div)\s+class="stat__list"[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const inner = m[2];
    // 找数值span - 所有<span>xxx</span>（去掉rank里的）
    const rankMatch = inner.match(/<div\s+rank="(\d+)"/);
    const rank = rankMatch ? parseInt(rankMatch[1], 10) : null;

    // 抓 rank div 外部的 span（即数值和标签，rank div内两个span分别是"联赛第"和排名数字，要排除）
    // 方法：先去掉 <div rank...>...</div>，剩下的span就是数值+标签
    const withoutRank = inner.replace(/<div[^>]*rank[^>]*>[\s\S]*?<\/div>/g, '');
    const spans = [];
    const spanRe = /<span>([\s\S]*?)<\/span>/g;
    let sm;
    while ((sm = spanRe.exec(withoutRank)) !== null) {
      spans.push(sm[1].trim());
    }
    if (spans.length < 2) continue;
    const rawVal = spans[0]; // 数值字符串，可能是"71.8","2225","0","1"
    const label = spans[1];  // 中文名称："上场场次"
    const value = parseStatValue(rawVal);
    if (!label) continue;
    out[label] = { value, rank };
  }
  return out;
}

function parseStatValue(s) {
  if (!s) return 0;
  s = String(s).replace(/,/g, '').trim();
  if (s === '-' || s === '') return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// === 如果直接运行，就测试 ===
if (require.main === module) {
  const fs = require('fs');
  const path = process.argv[2] || 'e:\\Sports\\_stat_bukayuesaka.html';
  const html = fs.readFileSync(path, 'utf8');
  const stats = parseStatHTML(html);
  console.log('解析到 stat 项数:', Object.keys(stats).length);
  const keysOrder = [
    '上场场次','首发','上场时间','场均上场时间','进球','场均进球','助攻','场均助攻',
    '点球','射门','射正','传球','红牌','黄牌',
    '解围','抢断','两黄变红','拦截','有效阻挡','越位','被侵犯','传球成功',
    '关键传球','传中球','传中球成功','长传','成功长传','任意球','任意球得分',
    '过人','过人成功','1对1拼抢','1对1拼抢成功','快攻','快攻射门','快攻进球','击中门框','丢失球权','传球被断'
  ];
  keysOrder.forEach(k => {
    if (stats[k]) console.log(`  ${k}: ${stats[k].value} (联赛第 ${stats[k].rank ?? '无'})`);
    else console.log(`  ${k}: 未找到`);
  });
  console.log('\n所有解析项:', JSON.stringify(stats, null, 2));
}

module.exports = { parseStatHTML, parseStatValue };
