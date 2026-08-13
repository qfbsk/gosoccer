/**
 * 9维雷达评分算法
 * 基于联赛排名 rank (1=第1名=最好, 数值越小越好)
 * 用户要求: 最后一名按 440 拟合（0分），第1名 100分。
 * 单项得分计算:
 *  - 正向指标（数值越大越好，所有维度均为正向，犯规=有力防守动作不吃牌=好）：score = 100 × (1 - (rank-1)/(R_MAX-1))
 */

const R_MAX = 440; // 最后一名基准

const DIMS = [
  { key: 'dribble',   cn: '盘带' },
  { key: 'shooting',  cn: '射门' },
  { key: 'passing',   cn: '传控' },
  { key: 'tactical',  cn: '战术' },
  { key: 'duels',     cn: '对抗' },
  { key: 'tackle',    cn: '抢断' },
  { key: 'teamDef',   cn: '联防' },
  { key: 'speed',     cn: '速度' },
  { key: 'stamina',   cn: '耐力' },
];

// 9个维度的关联数据项权重：[{label, weight, negative}]
const DIM_WEIGHTS = {
  // 1. 盘带
  dribble: [
    { label: '过人成功', weight: 0.35 },
    { label: '过人',     weight: 0.25 },
    { label: '1对1拼抢成功', weight: 0.25 },
    { label: '快攻',     weight: 0.15 },
  ],
  // 2. 射门
  shooting: [
    { label: '射正',     weight: 0.22 },
    { label: '进球',     weight: 0.22 },
    { label: '场均进球', weight: 0.20 },
    { label: '射门',     weight: 0.15 },
    { label: '任意球得分', weight: 0.11 },
    { label: '点球',     weight: 0.10 },
  ],
  // 3. 传控
  passing: [
    { label: '关键传球', weight: 0.25 },
    { label: '传中球成功', weight: 0.20 },
    { label: '传球成功', weight: 0.20 },
    { label: '成功长传', weight: 0.15 },
    { label: '传中球',   weight: 0.10 },
    { label: '长传',     weight: 0.10 },
  ],
  // 4. 战术（剔除红黄牌，犯规=有力防守不吃牌=正向）
  tactical: [
    { label: '助攻',     weight: 0.32 },
    { label: '有效阻挡', weight: 0.28 },
    { label: '被侵犯',   weight: 0.18 },
    { label: '点球',     weight: 0.12 },
    { label: '犯规',     weight: 0.10 },
  ],
  // 5. 对抗（剔除红黄牌，犯规=有力防守不吃牌=正向）
  duels: [
    { label: '1对1拼抢成功', weight: 0.35 },
    { label: '1对1拼抢',     weight: 0.20 },
    { label: '拦截',         weight: 0.22 },
    { label: '有效阻挡',     weight: 0.18 },
    { label: '犯规',         weight: 0.05 },
  ],
  // 6. 抢断（防守）—— 提高「抢断」权重
  tackle: [
    { label: '抢断',     weight: 0.50 },
    { label: '拦截',     weight: 0.30 },
    { label: '有效阻挡', weight: 0.20 },
  ],
  // 7. 联防（团队防守+解围）—— 新增「抢断」「拦截」，重新分配系数
  teamDef: [
    { label: '解围',     weight: 0.22 },
    { label: '1对1拼抢成功', weight: 0.15 },
    { label: '1对1拼抢', weight: 0.12 },
    { label: '有效阻挡', weight: 0.14 },
    { label: '抢断',     weight: 0.20 },
    { label: '拦截',     weight: 0.17 },
  ],
  // 8. 速度（快攻）
  speed: [
    { label: '快攻进球', weight: 0.35 },
    { label: '快攻射门', weight: 0.35 },
    { label: '快攻',     weight: 0.30 },
  ],
  // 9. 耐力（场均上场时间更重要，权重 0.6 / 上场时间 0.4）
  stamina: [
    { label: '场均上场时间', weight: 0.60 },
    { label: '上场时间',     weight: 0.40 },
  ],
};

/**
 * 单项排名转0-100分
 * @param {number|null} rank 排名（1=最好）
 * @param {boolean} negative 是否反向（如犯规：排名1=犯规最多=最差）
 * @param {object} opts  {fallback}  fallback=当没有rank或rank无效时作为兜底分数(0-1)代表相对位置，0=最差
 */
function rankToScore(rank, negative = false, fallback = 0.99) {
  let r;
  if (rank == null || isNaN(rank) || rank <= 0) {
    // 没有排名 - 按兜底。默认按"接近最差" (R_MAX附近)处理，但不要直接0分（替补球员很常见没数据，别太惨）
    // fallback=0.99意味着"接近最差位置"
    r = 1 + (R_MAX - 1) * fallback;
  } else if (rank > R_MAX) {
    r = R_MAX;
  } else {
    r = rank;
  }
  // 归一化 0..1 (0=第1名最好,1=R_MAX最差)
  const norm = (r - 1) / (R_MAX - 1);
  const score = negative ? norm * 100 : (1 - norm) * 100;
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

/**
 * 计算单个球员的9维评分
 * @param {object} stats {label: {value, rank}}  来自parseStatHTML的结果
 * @returns {object} {dimKey: {score, breakdown:[{label,rank,itemScore,weight}]}, totalAvg}
 */
function compute9DimRadar(stats) {
  stats = stats || {};
  const result = {};
  let totalScore = 0;
  for (const dim of DIMS) {
    const rules = DIM_WEIGHTS[dim.key];
    let wsum = 0, ssum = 0;
    const breakdown = [];
    for (const rule of rules) {
      const st = stats[rule.label];
      // 计算层：如果原始数值未知或 <=0，直接给 0 分（就算排名再高也没用）
      const rawVal = (st && typeof st.value === 'number') ? st.value : null;
      const hasPositiveValue = rawVal != null && rawVal > 0;
      const rank = st ? st.rank : null;
      let itemScore;
      if (!hasPositiveValue) {
        itemScore = 0;
      } else {
        itemScore = rankToScore(rank, !!rule.negative);
      }
      wsum += rule.weight;
      ssum += itemScore * rule.weight;
      breakdown.push({ label: rule.label, rank, itemScore, weight: rule.weight, negative: !!rule.negative, zeroed: !hasPositiveValue });
    }
    const dimScore = wsum > 0 ? Math.round((ssum / wsum) * 10) / 10 : 0;
    totalScore += dimScore;
    result[dim.key] = { score: dimScore, breakdown };
  }
  const totalAvg = Math.round((totalScore / DIMS.length) * 10) / 10;
  return { result, totalAvg, dims: DIMS };
}

// 作为命令行工具测试：node _radar_score.js <球员slug>  从players_raw.json里拿stats
if (require.main === module) {
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync('players_raw.json', 'utf8'));
  const flat = raw.flat || [];
  const slug = process.argv[2] || 'bukayuesaka';
  const p = flat.find(x => x.slug === slug);
  if (!p) { console.error('未找到球员slug:', slug); process.exit(1); }
  console.log(`${p.cnName} (${p.teamCn} ${p.position} #${p.jersey || '-'})`);
  if (!p.stats || p.stats.__error) {
    console.log('⚠️ 该球员没有stats数据（还没爬/爬失败）');
    process.exit(0);
  }
  const r = compute9DimRadar(p.stats);
  console.log('\n综合平均分:', r.totalAvg, '/100');
  console.log('\n9维明细:');
  for (const d of r.dims) {
    const v = r.result[d.key];
    const bar = '█'.repeat(Math.round(v.score / 4)) + '░'.repeat(25 - Math.round(v.score / 4));
    console.log(`  ${d.cn.padEnd(3, '　')} ${String(v.score).padStart(5, ' ')}  ${bar} `);
    // 拆解前3项
    const top3 = [...v.breakdown].sort((a, b) => (b.itemScore * b.weight) - (a.itemScore * a.weight)).slice(0, 3);
    process.stdout.write('         贡献TOP: ');
    console.log(top3.map(x => `${x.label}=${x.rank ?? '-'}→${x.itemScore}×${x.weight}`).join('  '));
  }
}

module.exports = { DIMS, DIM_WEIGHTS, R_MAX, rankToScore, compute9DimRadar };
