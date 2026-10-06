// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    const current = picked[key];
    if (current.source === '人工' && row.source === '自动') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      const previous = current;
      if (previous) {
        previous.endAt = row.at;
        previous.minutes += previous.lastGapMinutes || 0;
        previous.peakC = value > previous.peakC ? value : previous.peakC;
        previous.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      // 与上一条记录的间隔按固定记录间隔计
      current.lastGapMinutes = Number(settings.recordIntervalMinutes);
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：平均动力学温度
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + Number(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

// 放行判定：最长超限、累计超限、断链、探头校准四条
function releaseCheck(data, batch) {
  const settings = data.settings;
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = monthlyExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const conditions = [
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
  ];
  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

// ---------- 超限外推 ----------
// 外推口径：以各批次最后一条有效记录的时刻为「当前」（数据截止），按最近 6 小时的温度走势
// （最小二乘斜率）与近 24 小时的累计超限增速，估计单次与累计超限各自的临界时刻。
// 段长、累计的口径与上面的判定完全一致：段长按固定记录间隔计，累计跨月不重置（口径第 3 条）。
const TREND_WINDOW_HOURS = 6; // 走势窗口
const RATE_WINDOW_HOURS = 24; // 累计增速窗口
const SLOPE_FLAT_C_PER_HOUR = 0.15; // 斜率绝对值小于此视为平稳
const EPISODE_LOOKBACK_HOURS = 24 * 7; // 周期性超限段的回看范围
const CROSSING_HORIZON_HOURS = 48; // 走势越线只看这么远
const LEVEL_ORDER = ['已超', '紧急', '预警', '关注', '平稳', '无数据'];

// 与 store.nowText 同一时区口径，把任意 Date 写回文本时刻
function textOf(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function shiftText(atText, minutes) {
  return textOf(new Date(toDate(atText).getTime() + minutes * 60000));
}

function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 近窗温度走势：最小二乘斜率（℃/小时），少于 3 点按 0 计
function trendSlopeCPerHour(rows) {
  const n = rows.length;
  if (n < 3) return 0;
  const t0 = toDate(rows[0].at).getTime();
  const xs = rows.map((r) => (toDate(r.at).getTime() - t0) / 3600000);
  const ys = rows.map((r) => Number(r.temperatureC));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  return sxx ? sxy / sxx : 0;
}

function fmtDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '';
  const sign = minutes < 0 ? '-' : '';
  let rest = Math.abs(Math.round(minutes));
  const days = Math.floor(rest / 1440);
  rest -= days * 1440;
  const hours = Math.floor(rest / 60);
  rest -= hours * 60;
  const parts = [];
  if (days) parts.push(days + ' 天');
  if (hours) parts.push(hours + ' 小时');
  if (!days && rest) parts.push(rest + ' 分钟');
  if (!parts.length) return '0 分钟';
  return sign + parts.join(' ');
}

// 临界时刻列的显示文本：已超线 / 时刻（约多久后）/ 暂无触线迹象
function projectionDisplay(proj) {
  if (proj.state === 'breached') return '已超线';
  if (proj.breachAt) return proj.breachAt.slice(0, 16) + '（约 ' + fmtDuration(proj.minutesTo) + ' 后）';
  return '暂无触线迹象';
}

// 单批外推：当前进度 + 最近走势 → 单次/累计超限的临界时刻、风险等级与依据
function forecastBatch(data, batch) {
  const settings = data.settings;
  const interval = Number(settings.recordIntervalMinutes);
  const allowSingle = Number(settings.allowExcursionMinutes);
  const allowTotal = Number(settings.allowTotalExcursionMinutes);
  const upper = Number(settings.upperLimitC);
  const lower = Number(settings.lowerLimitC);
  const room = data.rooms.find((r) => r.id === batch.roomId) || null;
  const rows = effectiveRecords(data, batch.id);
  const base = {
    batchId: batch.id,
    code: batch.code,
    product: batch.product,
    spec: batch.spec,
    units: batch.units,
    status: batch.status,
    loadedAt: batch.loadedAt,
    roomCode: room ? room.code : '',
    roomStatus: room ? room.status : '',
  };
  if (!rows.length) {
    return Object.assign(base, {
      level: '无数据',
      levelRank: 5,
      asOf: '',
      inStorageMinutes: null,
      single: { state: 'none', breachAt: null, minutesTo: null, display: '—', note: '没有温度记录，无法外推' },
      total: { state: 'none', breachAt: null, minutesTo: null, display: '—', note: '没有温度记录，无法外推' },
      earliestBreachAt: null,
      minutesToEarliest: null,
      headline: '没有温度记录，无法外推',
      basis: ['没有任何温度记录，无法外推；按口径没有记录的批次不能放行'],
    });
  }
  const stats = segmentStats(rows, settings);
  const firstAt = rows[0].at;
  const asOf = rows[rows.length - 1].at;
  const lastTemp = Number(rows[rows.length - 1].temperatureC);
  const outNow = lastTemp > upper || lastTemp < lower;
  const openSegment = outNow && stats.segments.length ? stats.segments[stats.segments.length - 1] : null;

  // 最近走势：数据截止前 6 小时
  const trendFrom = shiftText(asOf, -TREND_WINDOW_HOURS * 60);
  const trendRows = rows.filter((r) => r.at >= trendFrom);
  const slope = store.round(trendSlopeCPerHour(trendRows), 3);
  const direction = slope >= SLOPE_FLAT_C_PER_HOUR ? '上升' : (slope <= -SLOPE_FLAT_C_PER_HOUR ? '下降' : '平稳');

  // 累计增速：数据截止前 24 小时（记录不足 24 小时按实际跨度）
  const spanMinutes = Math.max(store.minutesBetween(firstAt, asOf), interval);
  const rateWindowMinutes = Math.min(RATE_WINDOW_HOURS * 60, spanMinutes);
  const rateFrom = shiftText(asOf, -rateWindowMinutes);
  const rateRows = rows.filter((r) => r.at >= rateFrom);
  const recentExcursionMinutes = segmentStats(rateRows, settings).totalMinutes;
  const ratePerHour = store.round(recentExcursionMinutes / (rateWindowMinutes / 60), 2);

  // 若温度正在回到范围内，预计多少分钟后回来（用于判断当前段会不会提前结束）
  let backInMinutes = null;
  if (outNow && lastTemp > upper && slope <= -SLOPE_FLAT_C_PER_HOUR) backInMinutes = Math.max((lastTemp - upper) / (-slope) * 60, 0);
  if (outNow && lastTemp < lower && slope >= SLOPE_FLAT_C_PER_HOUR) backInMinutes = Math.max((lower - lastTemp) / slope * 60, 0);

  // ---- 单次连续超限 ----
  const longest = stats.longestMinutes;
  const singleMargin = allowSingle - longest;
  let single;
  if (longest > allowSingle) {
    single = { state: 'breached', breachAt: asOf, minutesTo: 0, note: '最长连续超限已 ' + longest + ' 分钟，超过门槛 ' + allowSingle + ' 分钟' };
  } else if (openSegment) {
    // 段还在长：每多一条超限记录多 interval 分钟，超过门槛即触线
    const needPoints = Math.floor((allowSingle - openSegment.minutes) / interval) + 1;
    const minutesTo = needPoints * interval;
    if (backInMinutes != null && backInMinutes < minutesTo) {
      const stopAt = openSegment.minutes + Math.floor(backInMinutes / interval) * interval;
      single = {
        state: 'clear', breachAt: null, minutesTo: null,
        note: '当前超限段已 ' + openSegment.minutes + ' 分钟；按近 ' + TREND_WINDOW_HOURS + ' 小时回落走势约 ' + fmtDuration(backInMinutes) + ' 后回到范围内，段长预计停在约 ' + stopAt + ' 分钟，够不到 ' + allowSingle + ' 分钟门槛',
      };
    } else {
      single = {
        state: 'accruing', breachAt: shiftText(asOf, minutesTo), minutesTo,
        note: '仍在超限段内（已 ' + openSegment.minutes + ' 分钟）且温度未见回落，再 ' + fmtDuration(minutesTo) + '（约 ' + needPoints + ' 条记录）即触单次线',
      };
    }
  } else {
    // 没有未闭合的段：看超限段是否反复出现且段长已贴住门槛
    const lookbackFrom = shiftText(asOf, -EPISODE_LOOKBACK_HOURS * 60);
    let segs = stats.segments.filter((s) => s.startAt >= lookbackFrom);
    if (segs.length < 2) segs = stats.segments; // 窗内不足两段时看全程
    if (segs.length >= 2) {
      const starts = segs.map((s) => s.startAt);
      const gaps = [];
      for (let i = 1; i < starts.length; i += 1) gaps.push(store.minutesBetween(starts[i - 1], starts[i]));
      const typicalGap = median(gaps);
      const typicalLen = median(segs.map((s) => s.minutes));
      const nextSegmentAt = shiftText(starts[starts.length - 1], typicalGap);
      if (typicalLen + interval > allowSingle) {
        single = {
          state: 'watch', breachAt: null, minutesTo: null, nextSegmentAt,
          note: '近 ' + segs.length + ' 段超限均约 ' + typicalLen + ' 分钟、约每 ' + fmtDuration(typicalGap) + ' 一段，段长已贴住 ' + allowSingle + ' 分钟门槛；下一段预计 ' + nextSegmentAt.slice(0, 16) + ' 前后开始，只要多持续一个记录间隔（' + interval + ' 分钟）即触单次线',
        };
      } else {
        single = { state: 'clear', breachAt: null, minutesTo: null, note: '近期超限段约 ' + typicalLen + ' 分钟，离 ' + allowSingle + ' 分钟门槛还有余量' };
      }
    } else {
      single = { state: 'clear', breachAt: null, minutesTo: null, note: segs.length === 1 ? '只有 1 段超限，看不出重复节奏' : '近期没有超限段' };
    }
    // 走势越线：温度持续朝限值走时的前兆
    if (single.state === 'clear') {
      let crossMinutes = null;
      let crossLimit = '';
      if (slope >= SLOPE_FLAT_C_PER_HOUR && lastTemp <= upper) { crossMinutes = (upper - lastTemp) / slope * 60; crossLimit = '上限'; } else if (slope <= -SLOPE_FLAT_C_PER_HOUR && lastTemp >= lower) { crossMinutes = (lastTemp - lower) / (-slope) * 60; crossLimit = '下限'; }
      if (crossMinutes != null && crossMinutes <= CROSSING_HORIZON_HOURS * 60) {
        const persistMinutes = (Math.floor(allowSingle / interval) + 1) * interval;
        single = {
          state: 'crossing',
          breachAt: shiftText(asOf, crossMinutes + persistMinutes),
          minutesTo: Math.round(crossMinutes + persistMinutes),
          crossingAt: shiftText(asOf, crossMinutes),
          note: '按近 ' + TREND_WINDOW_HOURS + ' 小时走势约 ' + fmtDuration(crossMinutes) + ' 后越出' + crossLimit + '；若越线后持续超限，约 ' + fmtDuration(crossMinutes + persistMinutes) + ' 后触单次线',
        };
      }
    }
  }

  // ---- 累计超限 ----
  const accumulated = stats.totalMinutes;
  const totalMargin = allowTotal - accumulated;
  let total;
  if (totalMargin < 0) {
    total = { state: 'breached', breachAt: asOf, minutesTo: 0, note: '累计超限已 ' + accumulated + ' 分钟，超过门槛 ' + allowTotal + ' 分钟' };
  } else if (totalMargin === 0) {
    total = { state: 'projected', breachAt: asOf, minutesTo: 0, note: '累计超限已到 ' + allowTotal + ' 分钟门槛，任何新的超限都会超线' };
  } else {
    let minutesTo = null;
    let totalHow = '';
    if (openSegment) {
      // 段内墙钟与累计 1:1 增长；若预计提前回到范围内，之后按近 24 小时增速
      if (backInMinutes == null || backInMinutes >= totalMargin) {
        minutesTo = totalMargin;
        totalHow = '当前段内 1:1 累积';
      } else if (ratePerHour > 0) {
        minutesTo = backInMinutes + (totalMargin - backInMinutes) / ratePerHour * 60;
        totalHow = '段内 1:1 累积约 ' + fmtDuration(backInMinutes) + ' 后回到范围内、之后按近 ' + RATE_WINDOW_HOURS + ' 小时增速 ' + ratePerHour + ' 分/时';
      }
    } else if (ratePerHour > 0) {
      minutesTo = totalMargin / ratePerHour * 60;
      totalHow = '近 ' + RATE_WINDOW_HOURS + ' 小时增速 ' + ratePerHour + ' 分/时';
    }
    if (minutesTo != null) {
      total = {
        state: 'projected', breachAt: shiftText(asOf, minutesTo), minutesTo: Math.round(minutesTo),
        note: '累计余量 ' + totalMargin + ' 分钟，按' + totalHow + '外推，约 ' + fmtDuration(minutesTo) + ' 后触累计线',
      };
    } else {
      total = { state: 'clear', breachAt: null, minutesTo: null, note: '近 ' + RATE_WINDOW_HOURS + ' 小时没有新增超限，照当前走势累计不再增长' };
    }
  }
  single.display = projectionDisplay(single);
  total.display = projectionDisplay(total);

  // ---- 综合等级：两条线取更早的临界时刻 ----
  const candidates = [];
  if (single.breachAt) candidates.push(single.breachAt);
  if (total.breachAt) candidates.push(total.breachAt);
  candidates.sort();
  const earliestBreachAt = candidates.length ? candidates[0] : null;
  const minutesToEarliest = earliestBreachAt ? Math.max(store.minutesBetween(asOf, earliestBreachAt), 0) : null;
  let level;
  let levelRank;
  if (single.state === 'breached' || total.state === 'breached') { level = '已超'; levelRank = 0; } else if (minutesToEarliest != null) {
    const hours = minutesToEarliest / 60;
    if (hours <= 4) { level = '紧急'; levelRank = 1; } else if (hours <= 24) { level = '预警'; levelRank = 2; } else if (hours <= 72) { level = '关注'; levelRank = 3; } else { level = '平稳'; levelRank = 4; }
  } else if (single.state === 'watch') { level = '关注'; levelRank = 3; } else { level = '平稳'; levelRank = 4; }

  let headline;
  if (level === '已超') {
    const what = [single.state === 'breached' ? '单次' : '', total.state === 'breached' ? '累计' : ''].filter(Boolean).join('与');
    headline = '已经超线（' + what + '）';
  } else if (minutesToEarliest != null) {
    const which = earliestBreachAt === single.breachAt && earliestBreachAt === total.breachAt ? '单次与累计线' : (earliestBreachAt === single.breachAt ? '单次线' : '累计线');
    headline = '约 ' + fmtDuration(minutesToEarliest) + ' 后触' + which;
  } else if (single.state === 'watch') {
    headline = '段长贴线，下一段超限即危险';
  } else {
    headline = '暂无触线迹象';
  }

  const inStorageMinutes = store.minutesBetween(batch.loadedAt, asOf);
  const basis = [
    '余量：单次最长 ' + longest + '/' + allowSingle + ' 分钟（' + (singleMargin >= 0 ? '余 ' + singleMargin : '已超 ' + (-singleMargin)) + '），累计 ' + accumulated + '/' + allowTotal + ' 分钟（' + (totalMargin >= 0 ? '余 ' + totalMargin : '已超 ' + (-totalMargin)) + '）',
    '走势：近 ' + TREND_WINDOW_HOURS + ' 小时' + direction + '（' + (slope > 0 ? '+' : '') + slope + '℃/时），当前 ' + lastTemp + '℃' + (outNow ? '，仍在超限段内' : '，在温度带内') + '；近 ' + store.round(rateWindowMinutes / 60, 1) + ' 小时新增超限 ' + recentExcursionMinutes + ' 分钟（' + ratePerHour + ' 分/时）',
    '在库：' + batch.loadedAt + ' 入库，数据截止 ' + asOf + '，已在库 ' + fmtDuration(inStorageMinutes),
  ];

  return Object.assign(base, {
    level,
    levelRank,
    asOf,
    inStorageMinutes,
    longestMinutes: longest,
    singleLimit: allowSingle,
    singleMargin,
    accumulatedMinutes: accumulated,
    totalLimit: allowTotal,
    totalMargin,
    openSegment: openSegment ? { startAt: openSegment.startAt, minutes: openSegment.minutes, peakC: openSegment.peakC } : null,
    trend: { windowHours: TREND_WINDOW_HOURS, slopeCPerHour: slope, direction, lastTempC: lastTemp, points: trendRows.length },
    recentExcursion: { windowHours: store.round(rateWindowMinutes / 60, 1), minutes: recentExcursionMinutes, ratePerHour },
    single,
    total,
    earliestBreachAt,
    minutesToEarliest,
    headline,
    basis,
  });
}

// 在办批次（在库/待放行）的外推清单，按紧迫程度排序
function forecastOpenBatches(data) {
  const open = data.batches.filter((b) => b.status === '在库' || b.status === '待放行');
  const items = open.map((b) => forecastBatch(data, b));
  items.sort((a, b) => {
    if (a.levelRank !== b.levelRank) return a.levelRank - b.levelRank;
    const am = a.minutesToEarliest == null ? Infinity : a.minutesToEarliest;
    const bm = b.minutesToEarliest == null ? Infinity : b.minutesToEarliest;
    if (am !== bm) return am - bm;
    return a.code < b.code ? -1 : 1;
  });
  const levelCounts = {};
  for (const item of items) levelCounts[item.level] = (levelCounts[item.level] || 0) + 1;
  const settings = data.settings;
  return {
    generatedAt: store.nowText(),
    settings: {
      lowerLimitC: Number(settings.lowerLimitC),
      upperLimitC: Number(settings.upperLimitC),
      allowExcursionMinutes: Number(settings.allowExcursionMinutes),
      allowTotalExcursionMinutes: Number(settings.allowTotalExcursionMinutes),
      recordIntervalMinutes: Number(settings.recordIntervalMinutes),
    },
    levelOrder: LEVEL_ORDER.slice(),
    levelCounts,
    items,
  };
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  releaseCheck,
  forecastBatch,
  forecastOpenBatches,
};
