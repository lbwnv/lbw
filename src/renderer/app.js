'use strict';
/* CapyLedger 渲染进程：只负责展示。渲染进程被 CSP 禁止联网，数据全部来自主进程。 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const api = window.relay || createDemoBridge();

const state = {
  data: null,
  mode: 'widget',
  chart: 'week',
  modelRange: 'week',
  authMode: 'password',
  syncing: false,
  timer: null,
  lastStatus: null,
  page: 'overview',
  logs: { range: 'today', page: 1, pageSize: 20, result: null, open: null, loading: false, seq: 0 }
};

const REFRESH_MS = 60 * 1000;
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/* ───────────────────────── 格式化 ───────────────────────── */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtTokens(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString('en-US');
}

function fmtInt(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

function fmtRate(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value >= 1000 ? fmtTokens(value) : (Math.round(value * 10) / 10).toString();
}

function fmtDate(unixSec, withYear = false) {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  return withYear ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` : `${d.getMonth() + 1}月${d.getDate()}日`;
}

function daysLeft(unixSec) {
  if (!unixSec) return null;
  return Math.ceil((unixSec * 1000 - Date.now()) / 86400000);
}

function relativeTime(iso) {
  if (!iso) return '尚未同步';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return '刚刚同步';
  if (seconds < 60) return `${seconds} 秒前同步`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前同步`;
  return `${new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 同步`;
}

/* 数字滚动动画 */
function setNumber(el, value, format = fmtMoney) {
  if (!el) return;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    el.textContent = '—';
    el._value = null;
    return;
  }
  const from = Number.isFinite(el._value) ? el._value : 0;
  el._value = value;
  cancelAnimationFrame(el._raf);
  const started = performance.now();
  const duration = 900;
  const step = now => {
    const t = Math.min(1, (now - started) / duration);
    const k = 1 - (1 - t) ** 4;
    el.textContent = format(from + (value - from) * k);
    if (t < 1) el._raf = requestAnimationFrame(step);
    else el.textContent = format(value);
  };
  el._raf = requestAnimationFrame(step);
}

const setText = (selector, text) => { const el = $(selector); if (el) el.textContent = text; };

/* ───────────────────────── 模型品牌色 ───────────────────────── */
const VENDORS = [
  [/claude|anthropic/i, 'A', '#d97757'],
  [/gemini|gemma|google/i, 'G', '#4c8df6'],
  [/deepseek/i, 'D', '#4d6bfe'],
  [/qwen|qwq|通义/i, 'Q', '#7b61ff'],
  [/glm|zhipu|chatglm/i, 'Z', '#3b6cf5'],
  [/kimi|moonshot/i, 'K', '#5b5b6b'],
  [/grok|xai/i, 'X', '#8a8f98'],
  [/mistral|codestral/i, 'M', '#fa6b2c'],
  [/llama|meta/i, 'L', '#1877f2'],
  [/doubao|seed/i, 'B', '#2fb9a6'],
  [/gpt|o1|o3|o4|openai|codex|dall|whisper|tts/i, 'O', '#10a37f']
];

function vendorOf(model) {
  for (const [pattern, letter, color] of VENDORS) if (pattern.test(model)) return { letter, color };
  return { letter: (model[0] || '?').toUpperCase(), color: 'var(--accent)' };
}

/* ───────────────────────── 图形 ───────────────────────── */
function renderSpark(container, values) {
  if (!container) return;
  const width = container.clientWidth || 320;
  const height = container.clientHeight || 46;
  if (!values.length) values = [0, 0];
  const max = Math.max(...values) || 1;
  const pad = 4;
  const points = values.map((v, i) => [
    (i / (values.length - 1 || 1)) * width,
    height - pad - (v / max) * (height - pad * 2)
  ]);
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  const last = points[points.length - 1];
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <path class="area" d="${d} L${last[0]},${height} L0,${height} Z"/>
    <path class="line" d="${d}"/>
    <circle class="dot" cx="${Math.min(last[0], width - 3)}" cy="${last[1]}" r="3"/></svg>`;
  const line = $('.line', container);
  line.style.setProperty('--len', Math.ceil(line.getTotalLength()) + 1);
}

function niceMax(value) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 6, 8, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;
}

function renderBars() {
  const data = state.data;
  const sym = data?.symbol || '$';
  let items = [];
  if (state.chart === 'week') {
    const days = data?.week?.days || Array.from({ length: 7 }, () => ({ spent: 0, requests: 0, tokens: 0 }));
    const todayKey = data ? keyOf(new Date()) : null;
    items = days.map((day, i) => ({
      label: WEEKDAYS[i],
      tip: `${day.date || WEEKDAYS[i]}`,
      value: day.spent,
      requests: day.requests,
      tokens: day.tokens,
      now: day.date === todayKey,
      future: day.future
    }));
  } else {
    const hourly = data?.today?.hourly || Array.from({ length: 24 }, () => ({ spent: 0, requests: 0, tokens: 0 }));
    const current = data?.today?.currentHour ?? new Date().getHours();
    items = hourly.map((hour, i) => ({
      label: i % 3 === 0 ? String(i).padStart(2, '0') : '',
      tip: `今日 ${String(i).padStart(2, '0')}:00 – ${String(i).padStart(2, '0')}:59`,
      value: hour.spent,
      requests: hour.requests,
      tokens: hour.tokens,
      now: Boolean(data) && i === current,
      future: Boolean(data) && i > current
    }));
  }
  const max = niceMax(Math.max(0, ...items.map(item => item.value)));
  $('#chartY').innerHTML = [1, 0.75, 0.5, 0.25, 0].map(f => `<span>${sym}${fmtAxis(max * f)}</span>`).join('');
  const bars = $('#bars');
  bars.style.setProperty('--gap', state.chart === 'week' ? '14px' : '4px');
  bars.innerHTML = items.map((item, n) => {
    const h = item.future ? 0 : Math.max(0, item.value / max);
    const cls = ['bar', state.chart === 'today' ? 'compact' : '', item.now ? 'now' : '', item.future ? 'future' : '', !item.future && item.value <= 0 ? 'empty-bar' : ''].join(' ');
    const tip = `<div class="t-dim">${escapeHtml(item.tip)}</div><div>消耗 <b>${sym}${fmtMoney(item.value)}</b></div><div>请求 <b>${fmtInt(item.requests)}</b> · Token <b>${fmtTokens(item.tokens)}</b></div>`;
    return `<div class="${cls}" style="--n:${n}" data-tip="${escapeHtml(tip)}"><div class="bar-fill" style="--h:${h}"></div><span class="bar-label">${item.label}</span></div>`;
  }).join('');
}

function fmtAxis(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  if (value >= 10) return Math.round(value).toString();
  return value === 0 ? '0' : value.toFixed(value < 1 ? 2 : 1).replace(/\.?0+$/, '');
}

function keyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderHeatmap() {
  const data = state.data;
  const days = data?.heatmap?.days || [];
  const grid = $('#heatGrid');
  const months = $('#heatMonths');
  if (!days.length) {
    grid.innerHTML = Array.from({ length: 53 * 7 }, (_, n) => `<i style="--n:${n % 60}"></i>`).join('');
    months.innerHTML = '';
    return;
  }
  const sym = data.symbol;
  const values = days.map(day => day.spent).filter(v => v > 0).sort((a, b) => a - b);
  const q = p => values[Math.min(values.length - 1, Math.floor(values.length * p))] || 0;
  const thresholds = [q(0.25), q(0.5), q(0.8)];
  const level = v => (v <= 0 ? 0 : v <= thresholds[0] ? 1 : v <= thresholds[1] ? 2 : v <= thresholds[2] ? 3 : 4);
  const todayKey = keyOf(new Date());
  const columns = Math.ceil(days.length / 7);
  grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  grid.style.aspectRatio = `${columns} / 7.6`;
  const cells = [];
  let lastMonth = -1;
  const labels = [];
  for (let n = 0; n < columns * 7; n += 1) {
    const day = days[n];
    if (!day) { cells.push('<i class="blank"></i>'); continue; }
    const [y, m, d] = day.date.split('-').map(Number);
    if (n % 7 === 0 && m !== lastMonth) {
      if (lastMonth !== -1 || d <= 7) labels.push(`<span style="left:${(n / 7 / columns) * 100}%">${m}月</span>`);
      lastMonth = m;
    }
    const tip = `<div class="t-dim">${y}年${m}月${d}日</div><div>消耗 <b>${sym}${fmtMoney(day.spent)}</b></div><div>请求 <b>${fmtInt(day.requests)}</b> · Token <b>${fmtTokens(day.tokens)}</b></div>`;
    cells.push(`<i class="l${level(day.spent)}${day.date === todayKey ? ' today' : ''}" style="--n:${Math.floor(n / 7)}" data-tip="${escapeHtml(tip)}"></i>`);
  }
  grid.innerHTML = cells.join('');
  months.innerHTML = labels.join('');
}

function renderChart() {
  const isHeat = state.chart === 'heatmap';
  $('#barChart').hidden = isHeat;
  $('#heatmap').hidden = !isHeat;
  $$('#chartTabs button').forEach(b => b.classList.toggle('active', b.dataset.chart === state.chart));
  const data = state.data;
  const sym = data?.symbol || '$';
  let foot;
  if (state.chart === 'week') {
    setText('#chartTitle', '本周消耗');
    setText('#chartSub', '按天统计 · 周一至周日');
    const elapsed = (data?.week?.days || []).filter(d => !d.future).length || 1;
    foot = [['本周总计', `${sym}${fmtMoney(data?.week?.spent)}`], ['日均', data ? `${sym}${fmtMoney((data.week.spent || 0) / elapsed)}` : '—'], ['请求数', fmtInt(data?.week?.requests)]];
    renderBars();
  } else if (state.chart === 'today') {
    setText('#chartTitle', '今日消耗');
    setText('#chartSub', '按小时统计 · 00:00 至今');
    const peak = (data?.today?.hourly || []).reduce((best, h, i) => (h.spent > best.v ? { v: h.spent, i } : best), { v: 0, i: -1 });
    foot = [['今日总计', `${sym}${fmtMoney(data?.today?.spent)}`], ['峰值时段', peak.i >= 0 ? `${String(peak.i).padStart(2, '0')}:00` : '—'], ['Token', fmtTokens(data?.today?.tokens)]];
    renderBars();
  } else {
    const days = data?.heatmap?.days || [];
    const active = days.filter(d => d.spent > 0 || d.requests > 0);
    const best = days.reduce((top, d) => (d.spent > (top?.spent || 0) ? d : top), null);
    setText('#chartTitle', '全年热力图');
    setText('#chartSub', data ? `自 ${data.heatmap.start} 起 · 每格一天` : '近 53 周每日消耗');
    foot = [['累计消耗', `${sym}${fmtMoney(data?.totals?.spent)}`], ['活跃天数', data ? `${active.length} 天` : '—'], ['单日最高', best ? `${sym}${fmtMoney(best.spent)}` : '—']];
    renderHeatmap();
  }
  $('#chartFoot').innerHTML = foot.map(([k, v]) => `<div><span>${k}</span><strong>${escapeHtml(v)}</strong></div>`).join('');
}

function ringOffset(ratio) {
  return 163.36 * (1 - Math.max(0, Math.min(1, ratio)));
}

function renderPlans() {
  const data = state.data;
  const list = data?.subscriptions || [];
  setText('#planCount', `${list.length} 个有效`);
  $('#planCount').className = `chip${list.length ? ' good' : ''}`;
  if (!data) { $('#plans').innerHTML = '<div class="empty">连接账户后显示订阅计划</div>'; return; }
  if (!list.length) { $('#plans').innerHTML = '<div class="empty">当前没有生效中的订阅</div>'; return; }
  const sym = data.symbol;
  $('#plans').innerHTML = list.map((plan, n) => {
    const left = daysLeft(plan.endAt);
    const chip = left === null ? '<span class="chip">长期</span>'
      : left <= 3 ? `<span class="chip bad">${left} 天后到期</span>`
        : left <= 7 ? `<span class="chip warn">剩 ${left} 天</span>` : `<span class="chip good">剩 ${left} 天</span>`;
    return `<div class="plan" style="--n:${n}">
      <div class="ring-wrap"><svg viewBox="0 0 64 64" class="ring"><circle cx="32" cy="32" r="26" class="ring-bg"/><circle cx="32" cy="32" r="26" class="ring-fg" stroke="url(#gradWarm)" data-offset="${ringOffset(plan.ratio)}"/></svg><div class="ring-text">${Math.round(plan.ratio * 100)}%</div></div>
      <div class="plan-body">
        <div class="plan-title"><strong title="${escapeHtml(plan.title)}">${escapeHtml(plan.title)}</strong>${chip}</div>
        <div class="plan-amount">${sym}${fmtMoney(plan.remaining)} <small>/ ${sym}${fmtMoney(plan.total)}</small></div>
        <div class="plan-meta"><span>已用 ${sym}${fmtMoney(plan.used)}</span><span>${plan.endAt ? `${fmtDate(plan.endAt, true)} 到期` : '无到期日'}</span></div>
      </div></div>`;
  }).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$('#plans .ring-fg').forEach(circle => { circle.style.strokeDashoffset = circle.dataset.offset; });
  }));
}

function renderModels() {
  const data = state.data;
  $$('#modelTabs button').forEach(b => b.classList.toggle('active', b.dataset.range === state.modelRange));
  const label = { today: '今天', week: '本周', month: '近 30 天' }[state.modelRange];
  setText('#modelSub', `${label} · 按消耗排序`);
  const list = data?.models?.[state.modelRange] || [];
  if (!list.length) {
    $('#models').innerHTML = `<div class="empty">${data ? `${label}还没有调用记录` : '暂无数据'}</div>`;
    return;
  }
  const sym = data.symbol;
  const head = '<div class="model-row head"><span>模型</span><span>消耗占比</span><span class="r">请求</span><span class="r">Token</span><span class="r">消耗</span></div>';
  $('#models').innerHTML = head + list.slice(0, 30).map((m, n) => {
    const vendor = vendorOf(m.model);
    return `<div class="model-row" style="--n:${n};--c:${vendor.color}">
      <div class="model-name"><i class="model-badge">${vendor.letter}</i><span title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</span></div>
      <div class="model-share"><div class="meter"><span data-w="${(m.share * 100).toFixed(1)}"></span></div><em>${(m.share * 100).toFixed(1)}%</em></div>
      <span class="r">${fmtInt(m.requests)}</span>
      <span class="r">${fmtTokens(m.tokens)}</span>
      <span class="r cost">${sym}${fmtMoney(m.spent)}</span></div>`;
  }).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$('#models .meter span').forEach(bar => { bar.style.width = `${Math.max(1.5, Number(bar.dataset.w))}%`; });
  }));
}

/* ───────────────────────── 使用日志 ───────────────────────── */
const pad2 = n => String(n).padStart(2, '0');

function toLocalInput(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function logRangeBounds() {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const sec = date => Math.floor(date.getTime() / 1000);
  if (state.logs.range === 'custom') {
    const start = new Date($('#logStart').value);
    const end = new Date($('#logEnd').value);
    return {
      start: Number.isNaN(start.getTime()) ? sec(today) : sec(start),
      end: Number.isNaN(end.getTime()) ? sec(now) : sec(end) + 59
    };
  }
  const days = { today: 0, '7d': 6, '30d': 29 }[state.logs.range] ?? 0;
  return { start: sec(today) - days * 86400, end: sec(now) + 60 };
}

function setLogRange(range) {
  state.logs.range = range;
  $$('#logRange button').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  $$('.custom-range').forEach(el => { el.hidden = range !== 'custom'; });
  if (range === 'custom' && !$('#logStart').value) {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    $('#logStart').value = toLocalInput(start);
    $('#logEnd').value = toLocalInput(now);
  }
}

async function loadLogs({ page = state.logs.page } = {}) {
  if (!state.data) { renderLogs(); return; }
  const seq = ++state.logs.seq;
  state.logs.page = page;
  state.logs.loading = true;
  $('#logTable').classList.add('loading');
  setSyncing(true);
  try {
    const result = await api.logs({
      page,
      pageSize: state.logs.pageSize,
      type: $('#logType').value,
      model: $('#logModel').value,
      token: $('#logToken').value,
      ...logRangeBounds()
    });
    if (seq !== state.logs.seq) return;
    if (!result.signedIn) { handleResult(await api.refresh()); return; }
    state.logs.result = result;
    state.logs.open = null;
    renderLogs();
  } catch (error) {
    if (seq === state.logs.seq) toast(error.message || '日志加载失败', true);
  } finally {
    if (seq === state.logs.seq) {
      state.logs.loading = false;
      $('#logTable').classList.remove('loading');
      setSyncing(false);
    }
  }
}

function fmtLogTime(unixSec) {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? '' : `${d.getFullYear()}-`}${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function speedCell(log) {
  if (!log.useTime && log.useTime !== 0) return '<span class="dim">—</span>';
  const cls = log.useTime >= 120 ? 'very-slow' : log.useTime >= 30 ? 'slow' : '';
  const first = log.firstToken !== null ? `<small>首字 ${log.firstToken.toFixed(1)}s</small>` : `<small>${log.stream ? '流式' : '非流式'}</small>`;
  return `<span class="speed"><span class="${cls}">${log.useTime}s</span>${first}</span>`;
}

function logDetail(log, sym) {
  const items = [
    ['输入 Token', fmtInt(log.prompt)],
    ['输出 Token', fmtInt(log.completion)],
    ['缓存读取', log.cacheRead ? fmtInt(log.cacheRead) : '—'],
    ['缓存写入', log.cacheWrite ? fmtInt(log.cacheWrite) : '—'],
    ['分组', log.group || '—'],
    ['令牌', log.token || '—'],
    ['模式', log.stream ? '流式' : '非流式'],
    ['费用', `${sym}${fmtMoney(log.cost)}`]
  ];
  if (log.modelPrice !== null && log.modelPrice > 0) items.push(['按次价格', `${sym}${fmtMoney(log.modelPrice)}`]);
  else if (log.modelRatio !== null) items.push(['模型倍率', String(log.modelRatio)], ['补全倍率', log.completionRatio !== null ? String(log.completionRatio) : '—']);
  if (log.groupRatio !== null) items.push(['分组倍率', String(log.groupRatio)]);
  if (log.reasoning) items.push(['推理强度', log.reasoning]);
  if (log.ip) items.push(['IP', log.ip]);
  const cells = items.map(([k, v]) => `<div><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');
  const content = log.content ? `<div class="wide"><span>详情</span><b>${escapeHtml(log.content)}</b></div>` : '';
  return `<div class="log-detail">${cells}${content}</div>`;
}

function renderLogs() {
  const result = state.logs.result;
  const table = $('#logTable');
  const sym = result?.symbol || state.data?.symbol || '$';
  setText('#logSpent', result?.stat ? `${sym}${fmtMoney(result.stat.spent)}` : '—');
  setText('#logTotal', result ? fmtInt(result.total) : '—');
  setText('#logRpm', result?.stat ? fmtRate(result.stat.rpm) : '—');
  setText('#logTpm', result?.stat ? fmtRate(result.stat.tpm) : '—');
  $('#logPager').hidden = !result || !result.total;
  if (!state.data) { table.innerHTML = '<div class="empty">连接账户后显示使用日志</div>'; return; }
  if (!result) { table.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (!result.items.length) { table.innerHTML = '<div class="empty">该时间段没有日志记录</div>'; return; }

  const head = '<div class="log-row head"><span>时间</span><span>类型</span><span>模型</span><span class="col-token">令牌</span><span class="r">输入 / 输出</span><span class="r">用时</span><span class="r">缓存</span><span class="r">花费</span><span></span></div>';
  table.innerHTML = head + result.items.map((log, n) => {
    const vendor = vendorOf(log.model || '?');
    const model = log.model
      ? `<div class="model-name"><i class="model-badge" style="--c:${vendor.color}">${vendor.letter}</i><span title="${escapeHtml(log.model)}">${escapeHtml(log.model)}</span></div>`
      : `<span class="ellipsis" title="${escapeHtml(log.content)}">${escapeHtml(log.content || '—')}</span>`;
    const tokens = log.type === 2 ? `<span class="r tokens"><b>${fmtTokens(log.prompt)}</b> / ${fmtTokens(log.completion)}</span>` : '<span class="r dim">—</span>';
    const cache = log.cacheRead || log.cacheWrite ? fmtTokens(log.cacheRead + log.cacheWrite) : '—';
    const open = state.logs.open === log.id;
    return `<div class="log-row${open ? ' open' : ''}" style="--n:${n}" data-id="${escapeHtml(log.id)}">
      <span class="time">${fmtLogTime(log.at)}</span>
      <span><i class="tag t${log.type}">${log.typeName}</i></span>
      ${model}
      <span class="ellipsis col-token" title="${escapeHtml(log.token)}">${escapeHtml(log.token || '—')}</span>
      ${tokens}
      <span class="r">${log.type === 2 ? speedCell(log) : '<span class="dim">—</span>'}</span>
      <span class="r ${cache === '—' ? 'dim' : ''}">${cache}</span>
      <span class="r cost">${log.cost ? `${sym}${fmtMoney(log.cost)}` : '<span class="dim">—</span>'}</span>
      <svg class="caret" viewBox="0 0 12 12"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
    </div>${open ? logDetail(log, sym) : ''}`;
  }).join('');

  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const from = (result.page - 1) * result.pageSize + 1;
  setText('#logPageInfo', `第 ${fmtInt(from)}–${fmtInt(Math.min(result.total, from + result.items.length - 1))} 条，共 ${fmtInt(result.total)} 条`);
  setText('#logPageNum', `${result.page} / ${pages}`);
  $('#logPrev').disabled = result.page <= 1;
  $('#logNext').disabled = result.page >= pages;
}

function setPage(page) {
  state.page = page === 'logs' ? 'logs' : 'overview';
  $('#fullView').dataset.page = state.page;
  $$('#pageTabs button').forEach(b => b.classList.toggle('active', b.dataset.page === state.page));
  const isLogs = state.page === 'logs';
  setText('#pageEyebrow', isLogs ? 'USAGE LOGS' : 'OVERVIEW');
  setText('#pageTitle', isLogs ? '使用日志' : '用量总览');
  $('#fullView').scrollTop = 0;
  if (isLogs && state.data && !state.logs.result) loadLogs({ page: 1 });
  else if (isLogs) renderLogs();
}

function bindLogEvents() {
  $$('#pageTabs button').forEach(b => b.addEventListener('click', () => setPage(b.dataset.page)));
  $$('#logRange button').forEach(b => b.addEventListener('click', () => {
    setLogRange(b.dataset.range);
    if (b.dataset.range !== 'custom') loadLogs({ page: 1 });
  }));
  $('#logType').addEventListener('change', () => loadLogs({ page: 1 }));
  $('#logSearch').addEventListener('click', () => loadLogs({ page: 1 }));
  ['#logModel', '#logToken', '#logStart', '#logEnd'].forEach(sel => $(sel).addEventListener('keydown', event => {
    if (event.key === 'Enter') loadLogs({ page: 1 });
  }));
  $('#logReset').addEventListener('click', () => {
    $('#logType').value = '0';
    $('#logModel').value = '';
    $('#logToken').value = '';
    $('#logStart').value = '';
    $('#logEnd').value = '';
    setLogRange('today');
    loadLogs({ page: 1 });
  });
  $('#logPageSize').addEventListener('change', event => {
    state.logs.pageSize = Number(event.target.value);
    loadLogs({ page: 1 });
  });
  $('#logPrev').addEventListener('click', () => loadLogs({ page: state.logs.page - 1 }));
  $('#logNext').addEventListener('click', () => loadLogs({ page: state.logs.page + 1 }));
  $('#logTable').addEventListener('click', event => {
    const row = event.target.closest('.log-row:not(.head)');
    if (!row) return;
    $$('#logTable .log-detail').forEach(el => el.remove());
    const wasOpen = row.classList.contains('open');
    $$('#logTable .log-row.open').forEach(el => el.classList.remove('open'));
    state.logs.open = null;
    if (wasOpen) return;
    const log = state.logs.result?.items.find(item => item.id === row.dataset.id);
    if (!log) return;
    state.logs.open = log.id;
    row.classList.add('open');
    row.insertAdjacentHTML('afterend', logDetail(log, state.logs.result.symbol));
  });
}

/* ───────────────────────── 主渲染 ───────────────────────── */
function render() {
  const data = state.data;
  const sym = data?.symbol || '$';
  $$('[data-sym]').forEach(el => { el.textContent = sym; });

  const signedIn = Boolean(data?.signedIn);
  const dot = $('#statusDot');
  dot.className = `status-dot ${signedIn ? (data.stale ? 'warn' : 'ok') : (state.lastStatus?.expired ? 'bad' : '')}`;
  setText('#siteLabel', signedIn ? `${data.username || '账户'} · ${data.host}` : (state.lastStatus?.expired ? '登录已过期' : '连接中转站'));
  setText('#menuUser', signedIn ? data.account.displayName || data.username : '未登录');
  setText('#menuSite', signedIn ? `${data.host}${data.account.group ? ` · ${data.account.group} 分组` : ''}` : '—');
  setText('#menuAvatar', signedIn ? (data.username || '?').slice(0, 1).toUpperCase() : '?');
  setText('#fullSiteName', signedIn ? data.siteName : '—');
  setText('#footHost', signedIn ? data.host : '你填写的站点');
  document.body.classList.toggle('live', signedIn && !data.stale);

  const account = data?.account;
  const today = data?.today;
  const week = data?.week;
  const subs = data?.subscriptionSummary;
  const balanceRatio = account && account.total ? account.balance / account.total : 0;
  const subRatio = subs && subs.total ? subs.remaining / subs.total : 0;

  // 小组件
  const now = new Date();
  setText('#widgetDate', `TODAY · ${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[(now.getDay() + 6) % 7]}`);
  setNumber($('#wToday'), today?.spent);
  setText('#wTodayReq', `${fmtInt(today?.requests)} 次请求`);
  setText('#wTodayTok', `${fmtTokens(today?.tokens)} Token`);
  setNumber($('#wBalance'), account?.balance);
  $('#wBalanceBar').style.width = `${Math.round(balanceRatio * 100)}%`;
  setText('#wBalanceMeta', account ? `已用 ${sym}${fmtMoney(account.used)}` : '已用 —');
  const chip = $('#wBalanceChip');
  if (account && account.balance !== null) {
    const low = account.balance < 1;
    chip.textContent = low ? '余额低' : '正常';
    chip.className = `chip ${low ? 'bad' : 'good'}`;
  } else {
    chip.textContent = '—';
    chip.className = 'chip';
  }
  setNumber($('#wSub'), subs ? subs.remaining : null);
  $('#wSubRing').style.strokeDashoffset = ringOffset(subRatio);
  setText('#wSubPct', subs && subs.count ? `${Math.round(subRatio * 100)}%` : '—');
  const nearest = daysLeft(subs?.nearestEnd);
  setText('#wSubMeta', !data ? '暂无订阅' : subs.count ? `${subs.count} 个 · ${nearest === null ? '长期' : `${nearest} 天后到期`}` : '暂无订阅');
  setNumber($('#wWeek'), week?.spent);
  setText('#wRpm', fmtRate(data?.live?.rpm));
  setText('#wTpm', fmtRate(data?.live?.tpm));
  setText('#widgetCtaText', signedIn ? '打开完整看板' : '连接中转站账户');
  setText('#widgetSync', signedIn ? `${relativeTime(data.fetchedAt)} · 每分钟自动刷新` : '等待连接');

  // 完整版
  setNumber($('#kToday'), today?.spent);
  setText('#kTodayReq', `${fmtInt(today?.requests)} 次请求`);
  setText('#kTodayTok', `${fmtTokens(today?.tokens)} Token`);
  setNumber($('#kBalance'), account?.balance);
  $('#kBalanceBar').style.width = `${Math.round(balanceRatio * 100)}%`;
  setText('#kBalanceUsed', account ? `已用 ${sym}${fmtMoney(account.used)}` : '已用 —');
  setText('#kBalanceTotal', account ? `总额 ${sym}${fmtMoney(account.total)}` : '总额 —');
  setNumber($('#kSub'), subs ? subs.remaining : null);
  $('#kSubBar').style.width = `${Math.round(subRatio * 100)}%`;
  setText('#kSubUsed', subs ? `已用 ${sym}${fmtMoney(subs.used)}` : '已用 —');
  setText('#kSubEnd', subs?.nearestEnd ? `最近到期 ${fmtDate(subs.nearestEnd)}` : '最近到期 —');
  setNumber($('#kWeek'), week?.spent);
  setText('#kWeekReq', `${fmtInt(week?.requests)} 次请求`);
  setText('#kWeekTok', `${fmtTokens(week?.tokens)} Token`);
  setText('#kRpm', `RPM ${fmtRate(data?.live?.rpm)}`);
  setText('#kTpm', `TPM ${fmtRate(data?.live?.tpm)}`);
  setText('#fullSub', signedIn
    ? `${data.account.displayName || data.username} · 历史请求 ${fmtInt(account.requests)} 次 · 累计消耗 ${sym}${fmtMoney(account.used)}`
    : '连接中转站账户后显示实时数据');
  setText('#fullSync', signedIn ? relativeTime(data.fetchedAt) : '尚未同步');

  const notice = $('#notice');
  const warnings = [];
  if (data?.stale) warnings.push(`网络异常，当前显示的是缓存数据：${data.message || ''}`);
  if (data && data.history && !data.history.ok) warnings.push(`历史用量暂未同步（${data.history.message}），图表可能不完整`);
  notice.hidden = !warnings.length;
  notice.textContent = warnings.join('；');

  drawSparks();
  renderChart();
  renderPlans();
  renderModels();
}

function drawSparks() {
  const hourly = state.data?.today?.hourly || [];
  const current = state.data?.today?.currentHour ?? 23;
  let sum = 0;
  const cumulative = hourly.slice(0, current + 1).map(h => (sum += h.spent));
  const values = cumulative.length > 1 ? [0, ...cumulative] : [0, 0];
  if (state.mode === 'widget') renderSpark($('#wSpark'), values);
  else renderSpark($('#kSpark'), values);
}

/* ───────────────────────── 数据 ───────────────────────── */
function setSyncing(on) {
  state.syncing = on;
  $('#shell').classList.toggle('syncing', on);
  $('#fullRefresh').disabled = on;
}

async function refresh({ silent = false } = {}) {
  if (state.syncing) return;
  setSyncing(true);
  try {
    const result = await api.refresh();
    handleResult(result);
    if (!silent && result.signedIn) toast(result.stale ? '网络异常，显示缓存数据' : '数据已更新', result.stale);
  } catch (error) {
    toast(error.message || '刷新失败', true);
  } finally {
    setSyncing(false);
  }
}

function handleResult(result) {
  state.lastStatus = result;
  const accountKey = result?.signedIn ? `${result.baseUrl}|${result.username}` : null;
  if (accountKey !== state.accountKey) {
    // 换了账户 / 退出：旧账户的日志不能留在界面上
    state.accountKey = accountKey;
    state.logs.result = null;
    state.logs.open = null;
  }
  if (result?.signedIn) {
    state.data = result;
  } else {
    state.data = null;
    if (result?.expired) openLogin({ message: result.message || '登录已过期，请重新登录', baseUrl: result.baseUrl });
  }
  render();
  if (state.page === 'logs') {
    if (state.data && !state.logs.result) loadLogs({ page: 1 });
    else renderLogs();
  }
}

function schedule() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (state.data) refresh({ silent: true });
    else render();
  }, REFRESH_MS);
}

/* ───────────────────────── 登录 ───────────────────────── */
async function openLogin({ message = '', baseUrl } = {}) {
  closeMenu();
  const status = await api.status().catch(() => ({}));
  $('#fBase').value = baseUrl || status.baseUrl || 'https://kapibala.asia';
  $('#fUser').value = status.loginName || '';
  $('#fPass').value = '';
  $('#fRemember').checked = status.rememberPassword ?? false;
  setAuthMode(status.authMode || state.authMode);
  $('#loginError').textContent = message;
  $('#loginModal').hidden = false;
  setTimeout(() => ($('#fUser').value ? $('#fPass') : $('#fUser')).focus(), 50);
}

function closeLogin() {
  $('#loginModal').hidden = true;
}

function setAuthMode(mode) {
  state.authMode = mode === 'token' ? 'token' : 'password';
  $$('#authTabs button').forEach(b => b.classList.toggle('active', b.dataset.auth === state.authMode));
  $$('.auth-pane').forEach(p => { p.hidden = p.dataset.pane !== state.authMode; });
}

async function submitLogin(event) {
  event.preventDefault();
  const button = $('#loginSubmit');
  const error = $('#loginError');
  error.textContent = '';
  button.disabled = true;
  button.classList.add('loading');
  setSyncing(true);
  try {
    const result = await api.login({
      baseUrl: $('#fBase').value,
      mode: state.authMode,
      username: $('#fUser').value,
      password: $('#fPass').value,
      remember: $('#fRemember').checked,
      accessToken: $('#fToken').value,
      userId: $('#fUid').value
    });
    $('#fPass').value = '';
    $('#fToken').value = '';
    closeLogin();
    handleResult(result);
    toast(`已连接 ${result.host || ''}`);
  } catch (err) {
    error.textContent = err.message || '登录失败';
    error.classList.remove('shake');
    void error.offsetWidth;
    error.classList.add('shake');
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    setSyncing(false);
  }
}

/* ───────────────────────── 交互 ───────────────────────── */
let toastTimer = null;
function toast(text, isError = false) {
  const el = $('#toast');
  setText('#toastText', text);
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function closeMenu() { $('#accountMenu').hidden = true; }

async function setMode(mode, animate = true) {
  if (mode === state.mode && animate) return;
  state.mode = mode;
  closeMenu();
  $$('#modeSwitch button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  if (animate) {
    $('.view-widget').style.opacity = $('.view-full').style.opacity = '0';
    api.setMode(mode);
    await new Promise(resolve => setTimeout(resolve, 220));
    $('.view-widget').style.opacity = $('.view-full').style.opacity = '';
  }
  document.body.dataset.mode = mode;
  render();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function toggleTheme(event) {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const rect = event.currentTarget.getBoundingClientRect();
  document.documentElement.style.setProperty('--tx', `${rect.left + rect.width / 2}px`);
  document.documentElement.style.setProperty('--ty', `${rect.top + rect.height / 2}px`);
  if (document.startViewTransition) document.startViewTransition(() => applyTheme(next));
  else applyTheme(next);
  api.setTheme(next);
}

function applyPin(on) {
  $('#pinBtn').classList.toggle('on', Boolean(on));
  $('#pinBtn').title = on ? '取消置顶' : '窗口置顶';
}

function bindTooltip() {
  const tip = $('#tooltip');
  document.addEventListener('pointerover', event => {
    const target = event.target.closest('[data-tip]');
    if (!target) { tip.classList.remove('show'); return; }
    tip.innerHTML = target.dataset.tip;
    tip.classList.add('show');
  });
  document.addEventListener('pointermove', event => {
    if (!tip.classList.contains('show')) return;
    const pad = 14;
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + tip.offsetWidth > window.innerWidth - 8) x = event.clientX - tip.offsetWidth - pad;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = event.clientY - tip.offsetHeight - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
}

function bindCardGlow() {
  document.addEventListener('pointermove', event => {
    const card = event.target.closest?.('.card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  }, { passive: true });
}

function bindResizeGrip() {
  const grip = $('#resizeGrip');
  let start = null;
  grip.addEventListener('pointerdown', event => {
    start = { x: event.screenX, y: event.screenY, w: window.outerWidth, h: window.outerHeight };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener('pointermove', event => {
    if (!start) return;
    api.resize({ width: start.w + event.screenX - start.x, height: start.h + event.screenY - start.y });
  });
  const end = () => { if (start) { start = null; api.resizeEnd(); } };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

function bindEvents() {
  $$('#modeSwitch button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#pinBtn').addEventListener('click', async () => applyPin(await api.setAlwaysOnTop(!$('#pinBtn').classList.contains('on'))));
  $('#minBtn').addEventListener('click', () => api.minimize());
  $('#maxBtn').addEventListener('click', () => api.toggleMaximize());
  $('#closeBtn').addEventListener('click', () => api.close());
  $('#widgetRefresh').addEventListener('click', () => (state.data ? refresh() : openLogin()));
  $('#fullRefresh').addEventListener('click', () => {
    if (!state.data) openLogin();
    else if (state.page === 'logs') loadLogs();
    else refresh();
  });
  bindLogEvents();
  $('#widgetCta').addEventListener('click', () => (state.data ? setMode('full') : openLogin()));

  $('#sitePill').addEventListener('click', event => {
    event.stopPropagation();
    if (!state.data) { openLogin(); return; }
    const menu = $('#accountMenu');
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', event => { if (!event.target.closest('#accountMenu')) closeMenu(); });
  $('#accountMenu').addEventListener('click', async event => {
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    closeMenu();
    if (action === 'refresh') refresh();
    if (action === 'open-site') api.openSite();
    if (action === 'switch') openLogin();
    if (action === 'logout') {
      await api.logout();
      handleResult({ signedIn: false });
      state.lastStatus = null;
      render();
      toast('已退出，本地凭据与缓存已清除');
    }
  });

  $$('#chartTabs button').forEach(b => b.addEventListener('click', () => { state.chart = b.dataset.chart; renderChart(); }));
  $$('#modelTabs button').forEach(b => b.addEventListener('click', () => { state.modelRange = b.dataset.range; renderModels(); }));

  $('#loginForm').addEventListener('submit', submitLogin);
  $('#loginClose').addEventListener('click', closeLogin);
  $$('#authTabs button').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));
  $('#togglePass').addEventListener('click', () => {
    const input = $('#fPass');
    input.type = input.type === 'password' ? 'text' : 'password';
    setText('#togglePass', input.type === 'password' ? '显示' : '隐藏');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeLogin(); closeMenu(); }
    if (event.key === 'F5' || (event.ctrlKey && event.key.toLowerCase() === 'r')) { event.preventDefault(); if (state.data) refresh(); }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawSparks, 120); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.data && Date.now() - new Date(state.data.fetchedAt).getTime() > REFRESH_MS) refresh({ silent: true });
  });
  api.onRefreshRequest?.(() => (state.data ? refresh() : openLogin()));
  api.onSettings?.(settings => applyPin(settings.alwaysOnTop));
  bindTooltip();
  bindCardGlow();
  bindResizeGrip();
}

async function init() {
  const settings = await api.getSettings();
  applyTheme(settings.theme || 'dark');
  applyPin(settings.alwaysOnTop);
  await setMode(settings.mode === 'full' ? 'full' : 'widget', false);
  bindEvents();
  render();
  const status = await api.status();
  if (status.signedIn) await refresh({ silent: true });
  else openLogin();
  schedule();
}

init();

/* ───────────────────────── 浏览器预览用的演示数据 ─────────────────────────
   只有在普通浏览器里直接打开 index.html（没有 Electron 预加载）时才会启用，
   正式运行时 window.relay 一定存在，这段代码不会执行。 */
function createDemoBridge() {
  document.body.classList.add('browser-preview');
  const settings = { mode: 'full', theme: 'dark', alwaysOnTop: false };
  const rand = seed => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const r = rand(42);
  const now = new Date();
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const monday = new Date(day0); monday.setDate(day0.getDate() - ((day0.getDay() + 6) % 7));
  const start = new Date(monday); start.setDate(start.getDate() - 52 * 7);
  const days = [];
  for (const c = new Date(start); c <= now; c.setDate(c.getDate() + 1)) {
    const active = r() > 0.35;
    const spent = active ? r() ** 2 * 24 : 0;
    days.push({ date: keyOf(c), spent, requests: Math.round(spent * 38), tokens: Math.round(spent * 210000) });
  }
  const hourly = Array.from({ length: 24 }, (_, h) => {
    const spent = h <= now.getHours() && h >= 8 ? r() * 1.6 : 0;
    return { spent, requests: Math.round(spent * 40), tokens: Math.round(spent * 200000) };
  });
  const sum = (list, key) => list.reduce((s, x) => s + x[key], 0);
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    const found = days.find(x => x.date === keyOf(d)) || { spent: 0, requests: 0, tokens: 0 };
    return { ...found, date: keyOf(d), future: d > now };
  });
  const models = ['claude-sonnet-4-5', 'gpt-5-codex', 'gemini-2.5-pro', 'deepseek-v3.2', 'glm-4.6', 'qwen3-coder-plus'].map((model, i) => ({
    model, spent: 12 / (i + 1), tokens: 2.2e6 / (i + 1), requests: Math.round(420 / (i + 1))
  }));
  const total = sum(models, 'spent');
  const modelList = models.map(m => ({ ...m, share: m.spent / total }));
  const dashboard = {
    signedIn: true, baseUrl: 'https://kapibala.asia', host: 'kapibala.asia', siteName: '卡皮巴拉API', username: 'demo',
    fetchedAt: now.toISOString(), currency: 'USD', symbol: '$',
    account: { username: 'demo', displayName: 'demo', group: 'default', balance: 86.42, used: 213.58, total: 300, requests: 18234 },
    live: { rpm: 3.2, tpm: 18400 },
    today: { spent: sum(hourly, 'spent'), requests: sum(hourly, 'requests'), tokens: sum(hourly, 'tokens'), hourly, currentHour: now.getHours() },
    week: { spent: sum(weekDays, 'spent'), requests: sum(weekDays, 'requests'), tokens: sum(weekDays, 'tokens'), days: weekDays },
    heatmap: { start: keyOf(start), days },
    totals: { spent: sum(days, 'spent'), tokens: sum(days, 'tokens'), requests: sum(days, 'requests') },
    models: { today: modelList.slice(0, 3), week: modelList, month: modelList },
    subscriptions: [
      { id: '1', title: 'Coding Plan Pro', total: 100, used: 37.5, remaining: 62.5, ratio: 0.625, endAt: Date.now() / 1000 + 18 * 86400 },
      { id: '2', title: 'Coding Plan Lite', total: 30, used: 26, remaining: 4, ratio: 0.133, endAt: Date.now() / 1000 + 2 * 86400 }
    ],
    subscriptionSummary: { count: 2, total: 130, used: 63.5, remaining: 66.5, nearestEnd: Date.now() / 1000 + 2 * 86400 },
    history: { ok: true }, stale: false
  };
  const later = value => new Promise(resolve => setTimeout(() => resolve(value), 500));
  const demoLogs = Array.from({ length: 137 }, (_, i) => {
    const m = models[i % models.length].model;
    const error = i % 23 === 7;
    const prompt = Math.round(2000 + r() * 60000);
    const completion = Math.round(200 + r() * 6000);
    const cost = error ? 0 : (prompt * 3 + completion * 15) / 1e6;
    return {
      id: String(9000 - i), at: Math.floor(Date.now() / 1000) - i * 173, type: error ? 5 : 2, typeName: error ? '错误' : '消费',
      model: m, token: i % 3 ? 'claude-code' : 'cursor', group: 'default', stream: i % 4 !== 0,
      useTime: Math.round(2 + r() * (i % 9 === 0 ? 140 : 25)), firstToken: i % 4 ? 0.6 + r() * 3 : null,
      prompt: error ? 0 : prompt, completion: error ? 0 : completion,
      cacheRead: i % 2 ? Math.round(prompt * 0.8) : 0, cacheWrite: i % 5 === 0 ? 3200 : 0,
      quota: cost * 500000, cost, modelRatio: 1.5, groupRatio: 1, completionRatio: 5, modelPrice: null,
      reasoning: '', content: error ? 'upstream error: status 529, overloaded' : '', ip: ''
    };
  });
  return {
    logs: query => later({
      signedIn: true, symbol: '$', page: query.page, pageSize: query.pageSize, total: demoLogs.length,
      items: demoLogs.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      stat: { spent: demoLogs.reduce((s, x) => s + x.cost, 0), rpm: 3.2, tpm: 18400 }
    }),
    status: async () => ({ signedIn: true, baseUrl: dashboard.baseUrl }),
    login: () => later(dashboard),
    refresh: () => later({ ...dashboard, fetchedAt: new Date().toISOString() }),
    logout: async () => ({ signedIn: false }),
    openSite: async () => {},
    getSettings: async () => settings,
    setTheme: async theme => theme,
    setMode: async mode => mode,
    setAlwaysOnTop: async on => on,
    minimize() {}, close() {}, toggleMaximize() {}, resize() {}, resizeEnd() {}
  };
}
