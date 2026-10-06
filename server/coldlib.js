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

// —— 风险外推：按当前超限进度与最近温度走势，估计在办批次距破限还有多久 ——

const TREND_POINTS = 8; // 温度走势窗口：最近几个记录点
const DUTY_WINDOW_MINUTES = 24 * 60; // 累计超限速率窗口：最近 24 小时
const SLOPE_EPSILON_PER_MIN = 0.001; // 每分钟不足这个斜率视为走势平稳

// 时刻文本加分钟数，按 +08:00 口径写回文本
function addMinutes(atText, minutes) {
  const d = new Date(toDate(atText).getTime() + minutes * 60000 + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function fmtDuration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return m + ' 分钟';
  if (m < 1440) return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟';
  return Math.floor(m / 1440) + ' 天 ' + Math.floor((m % 1440) / 60) + ' 小时';
}

// 最近若干点的线性走势（最小二乘），斜率单位 ℃/分钟
function recentTrend(rows) {
  const pts = rows.slice(-TREND_POINTS);
  if (pts.length < 3) return null;
  const t0 = toDate(pts[0].at).getTime();
  const xs = pts.map((r) => (toDate(r.at).getTime() - t0) / 60000);
  const ys = pts.map((r) => Number(r.temperatureC));
  const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sxy += (xs[i] - xm) * (ys[i] - ym);
    sxx += (xs[i] - xm) * (xs[i] - xm);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return {
    points: pts.length,
    windowMinutes: Math.round(xs[xs.length - 1] - xs[0]),
    slopePerMinute: slope,
    slopeCPerHour: store.round(slope * 60, 2),
    lastTempC: ys[ys.length - 1],
  };
}

// 最近 24 小时窗口内的超限占空比：窗口内超限分钟 / 窗口实际记录跨度；窗口几乎没记录时退到全程
function recentDutyRate(rows, settings, baseAt) {
  const from = addMinutes(baseAt, -DUTY_WINDOW_MINUTES);
  const scoped = rows.filter((r) => r.at > from);
  let minutes = segmentStats(scoped, settings).totalMinutes;
  let span = scoped.length > 1 ? store.minutesBetween(scoped[0].at, baseAt) : 0;
  if (!(span > 0)) {
    minutes = segmentStats(rows, settings).totalMinutes;
    span = rows.length > 1 ? store.minutesBetween(rows[0].at, baseAt) : 0;
  }
  if (!(span > 0)) return null;
  return { minutes, spanMinutes: span, rate: minutes / span };
}

// 单个批次的外推：单次连续超限与累计超限各给一个临界时刻
function forecastBatch(data, batch) {
  const settings = data.settings;
  const singleLimit = Number(settings.allowExcursionMinutes);
  const totalLimit = Number(settings.allowTotalExcursionMinutes);
  const upper = Number(settings.upperLimitC);
  const lower = Number(settings.lowerLimitC);
  const room = data.rooms.find((r) => r.id === batch.roomId);
  const rows = effectiveRecords(data, batch.id);
  const item = {
    batchId: batch.id,
    code: batch.code,
    product: batch.product,
    roomCode: room ? room.code : '',
    status: batch.status,
    loadedAt: batch.loadedAt,
    recordCount: rows.length,
    baseAt: '',
    inStorageMinutes: 0,
    staleMinutes: 0,
    single: null,
    total: null,
    trend: null,
    minutesToBreach: null,
    riskLevel: '暂无数据',
    basis: [],
  };
  if (!rows.length) {
    item.basis.push('暂无温度记录，无法外推；没有温度记录的批次不能放行');
    return item;
  }

  const stats = segmentStats(rows, settings);
  const lastRow = rows[rows.length - 1];
  const baseAt = lastRow.at;
  const lastTemp = Number(lastRow.temperatureC);
  const outNow = lastTemp > upper || lastTemp < lower;
  item.baseAt = baseAt;
  item.inStorageMinutes = store.minutesBetween(batch.loadedAt, baseAt);
  item.staleMinutes = store.minutesBetween(baseAt, store.nowText());

  // 温度走势：最近几个点的线性拟合，判断是否朝界外走
  const trend = recentTrend(rows);
  let trendSide = null;
  let headroomC = null;
  if (trend) {
    if (trend.slopePerMinute > SLOPE_EPSILON_PER_MIN && lastTemp < upper) {
      trendSide = 'upper';
      headroomC = store.round(upper - lastTemp, 1);
    } else if (trend.slopePerMinute < -SLOPE_EPSILON_PER_MIN && lastTemp > lower) {
      trendSide = 'lower';
      headroomC = store.round(lastTemp - lower, 1);
    }
    item.trend = {
      points: trend.points,
      windowMinutes: trend.windowMinutes,
      slopeCPerHour: trend.slopeCPerHour,
      lastTempC: lastTemp,
      side: trendSide,
      headroomC,
    };
  }

  // 单次连续超限：在段中按段余量直推；不在段中按走势先推触界、再加单次门槛
  const single = {
    limit: singleLimit,
    used: stats.longestMinutes,
    remaining: Math.max(0, singleLimit - stats.longestMinutes),
    inSegmentNow: false,
    segmentMinutes: 0,
    enterAt: null,
    breachAt: null,
    minutesToBreach: null,
  };
  if (outNow) {
    const seg = stats.segments[stats.segments.length - 1];
    single.inSegmentNow = true;
    single.segmentMinutes = seg.minutes;
    single.minutesToBreach = Math.max(0, singleLimit - seg.minutes);
    single.breachAt = addMinutes(baseAt, single.minutesToBreach);
  } else if (trend && trendSide) {
    const tEnter = headroomC / Math.abs(trend.slopePerMinute);
    single.enterAt = addMinutes(baseAt, tEnter);
    single.minutesToBreach = Math.round(tEnter + singleLimit);
    single.breachAt = addMinutes(baseAt, tEnter + singleLimit);
  }
  item.single = single;

  // 累计超限：余量与放行判定同口径；在段中按实时速率，否则按最近窗口的超限占空比
  const accumulated = monthlyExcursionMinutes(data, batch.id);
  const total = {
    limit: totalLimit,
    used: accumulated,
    remaining: Math.max(0, totalLimit - accumulated),
    ratePerHour: 0,
    breachAt: null,
    minutesToBreach: null,
  };
  let duty = null;
  if (accumulated >= totalLimit) {
    total.minutesToBreach = 0;
    total.breachAt = baseAt;
  } else if (outNow) {
    total.ratePerHour = 60;
    total.minutesToBreach = total.remaining;
    total.breachAt = addMinutes(baseAt, total.remaining);
  } else {
    duty = recentDutyRate(rows, settings, baseAt);
    if (duty && duty.rate > 0) {
      total.ratePerHour = store.round(duty.rate * 60, 4);
      total.minutesToBreach = Math.round(total.remaining / duty.rate);
      total.breachAt = addMinutes(baseAt, total.minutesToBreach);
    }
  }
  item.total = total;

  // 风险等级：取两个临界中较早者分档
  const candidates = [single.minutesToBreach, total.minutesToBreach].filter((v) => v != null);
  item.minutesToBreach = candidates.length ? Math.min.apply(null, candidates) : null;
  if (stats.longestMinutes > singleLimit || accumulated > totalLimit) item.riskLevel = '已破限';
  else if (item.minutesToBreach == null) item.riskLevel = '平稳';
  else if (item.minutesToBreach <= 60) item.riskLevel = '紧急';
  else if (item.minutesToBreach <= 240) item.riskLevel = '高';
  else if (item.minutesToBreach <= 720) item.riskLevel = '中';
  else if (item.minutesToBreach <= 1440) item.riskLevel = '低';
  else item.riskLevel = '平稳';

  // 依据：超限余量、最近温度走势、剩余在库时长
  const basis = item.basis;
  if (single.inSegmentNow) {
    basis.push('当前正处于超限段，已连续超限 ' + single.segmentMinutes + ' 分钟，单次余量 ' + Math.max(0, singleLimit - single.segmentMinutes) + ' 分钟（门槛 ' + singleLimit + ' 分钟）');
  } else {
    basis.push('单次超限余量 ' + single.remaining + ' 分钟（最长连续超限 ' + single.used + '/' + singleLimit + ' 分钟）');
  }
  basis.push('累计超限余量 ' + total.remaining + ' 分钟（判定口径已计 ' + total.used + '/' + totalLimit + ' 分钟）');
  if (trend) {
    const spanText = '最近 ' + fmtDuration(trend.windowMinutes) + '（' + trend.points + ' 个点）';
    const slopeText = (trend.slopeCPerHour >= 0 ? '+' : '') + trend.slopeCPerHour + '℃/小时';
    if (outNow) basis.push(spanText + '当前 ' + lastTemp + '℃ 已超限，斜率 ' + slopeText);
    else if (trendSide === 'upper') basis.push(spanText + '温度上行 ' + slopeText + '，当前 ' + lastTemp + '℃，距上限 ' + headroomC + '℃');
    else if (trendSide === 'lower') basis.push(spanText + '温度下行 ' + slopeText + '，当前 ' + lastTemp + '℃，距下限 ' + headroomC + '℃');
    else basis.push(spanText + '温度走势平稳（' + slopeText + '），当前 ' + lastTemp + '℃');
  }
  if (duty && duty.rate > 0 && !outNow && total.minutesToBreach != null) {
    basis.push('最近 ' + fmtDuration(duty.spanMinutes) + ' 内超限 ' + duty.minutes + ' 分钟（占空比 ' + store.round(duty.rate * 100, 1) + '%），按此速率累计余量约可撑 ' + fmtDuration(total.minutesToBreach));
  }
  basis.push('已入库 ' + fmtDuration(item.inStorageMinutes) + '（' + String(batch.loadedAt).slice(0, 16) + ' 起），记录最新至 ' + String(baseAt).slice(0, 16));
  if (item.staleMinutes > Number(settings.chainGapMinutes)) {
    basis.push('记录已停滞 ' + fmtDuration(item.staleMinutes) + '，外推以最后记录时刻为基准');
  }
  return item;
}

const RISK_LEVEL_ORDER = { 已破限: 0, 紧急: 1, 高: 2, 中: 3, 低: 4, 平稳: 5, 暂无数据: 6 };

// 在办批次（在库、待放行）的风险清单，按紧迫程度排序
function riskBoard(data) {
  const settings = data.settings;
  const items = data.batches
    .filter((b) => b.status === '在库' || b.status === '待放行')
    .map((b) => forecastBatch(data, b));
  items.sort((a, b) => {
    const la = RISK_LEVEL_ORDER[a.riskLevel] != null ? RISK_LEVEL_ORDER[a.riskLevel] : 9;
    const lb = RISK_LEVEL_ORDER[b.riskLevel] != null ? RISK_LEVEL_ORDER[b.riskLevel] : 9;
    if (la !== lb) return la - lb;
    const ta = a.minutesToBreach == null ? Infinity : a.minutesToBreach;
    const tb = b.minutesToBreach == null ? Infinity : b.minutesToBreach;
    if (ta !== tb) return ta - tb;
    const ra = a.total ? a.total.remaining : Infinity;
    const rb = b.total ? b.total.remaining : Infinity;
    return ra - rb;
  });
  return {
    generatedAt: store.nowText(),
    settings: {
      lowerLimitC: Number(settings.lowerLimitC),
      upperLimitC: Number(settings.upperLimitC),
      allowExcursionMinutes: Number(settings.allowExcursionMinutes),
      allowTotalExcursionMinutes: Number(settings.allowTotalExcursionMinutes),
      recordIntervalMinutes: Number(settings.recordIntervalMinutes),
    },
    items,
  };
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
  forecastBatch,
  riskBoard,
  releaseCheck,
};
