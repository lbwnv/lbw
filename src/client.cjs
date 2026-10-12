'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 中转站 API 客户端（New API / Kapibala 兼容）
//
// 这是整个应用里【唯一】发起网络请求的文件。它只会访问你在登录框里填写的
// 站点地址（默认 https://kapibala.asia），不会连接任何其他服务器，没有遥测、
// 没有自动更新、没有统计上报。审查本文件即可确认所有出站流量。
//
// 用到的接口（全部为 New API 标准接口）：
//   GET  /api/status               公共配置（货币单位、汇率）
//   POST /api/user/login           账号密码登录
//   POST /api/user/auth/refresh    Kapibala 短期令牌续期（标准 New API 没有则跳过）
//   GET  /api/user/self            账户余额
//   GET  /api/subscription/self    订阅（Coding Plan）
//   GET  /api/subscription/plans   订阅名称
//   GET  /api/log/self/stat        今日/本周实时消耗与 RPM/TPM
//   GET  /api/data/self            按小时聚合的历史用量（热力图、模型统计）
//   GET  /api/log/self             使用日志页；也用于站点关闭聚合接口时兜底
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('node:fs/promises');
const path = require('node:path');
const { safeStorage } = require('electron');

const DEFAULT_BASE_URL = 'https://kapibala.asia';
const USER_AGENT = 'CapyLedger/1.0 (Windows)';
const DAY = 86400000;
const HEATMAP_WEEKS = 53;
const OVERLAP_DAYS = 2;
const CHUNK_DAYS = 30;
const LOG_PAGE_SIZE = 100;
const LOG_MAX_PAGES = 30;

class ClientError extends Error {
  constructor(message, code = 'CLIENT_ERROR', status = 0) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    this.status = status;
  }
}

const authExpired = (message = '登录已过期，请重新登录') => new ClientError(message, 'AUTH_EXPIRED');
const isAuthError = e => e?.code === 'AUTH_EXPIRED' || e?.status === 401 || e?.status === 403;
const isNetworkError = e => e?.code === 'NETWORK_ERROR' || e?.code === 'TIMEOUT';

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(typeof value === 'string' ? value.replace(/,/g, '').trim() : value);
  return Number.isFinite(n) ? n : null;
}

function int(value) {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

function pick(object, keys) {
  if (!object || typeof object !== 'object') return null;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return null;
}

// 秒或毫秒时间戳统一转为秒
function toUnix(value) {
  const n = num(value);
  if (n !== null) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  const date = new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
}

function startOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function startOfWeek(date = new Date()) {
  const result = startOfDay(date);
  const weekday = result.getDay();
  result.setDate(result.getDate() - (weekday === 0 ? 6 : weekday - 1));
  return result;
}

function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const unix = date => Math.floor(date.getTime() / 1000);

function normalizeBaseUrl(input) {
  let text = String(input || '').trim();
  if (!text) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new ClientError('站点地址格式不正确', 'INVALID_URL'); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new ClientError('为保护密码安全，仅支持 HTTPS 站点', 'INVALID_URL');
  }
  return url.origin;
}

function cookiesFrom(headers) {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return list.map(cookie => cookie.split(';', 1)[0].trim()).filter(Boolean).join('; ');
}

function mergeCookies(...headers) {
  const jar = new Map();
  for (const header of headers) {
    for (const part of String(header || '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0) jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

// 凭据使用 Windows DPAPI（safeStorage）加密，只有当前 Windows 用户能解密
class SecureStore {
  constructor(file) {
    this.file = file;
    this.value = undefined;
  }

  async read() {
    if (this.value !== undefined) return this.value;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.value = safeStorage.isEncryptionAvailable()
        ? JSON.parse(safeStorage.decryptString(Buffer.from(raw, 'base64')))
        : null;
    } catch {
      this.value = null;
    }
    return this.value;
  }

  async write(value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new ClientError('Windows 加密存储不可用，无法安全保存凭据', 'STORAGE_UNAVAILABLE');
    }
    const blob = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, blob, 'utf8');
    await fs.rename(temp, this.file);
    this.value = value;
  }

  async clear() {
    this.value = null;
    await fs.rm(this.file, { force: true });
  }
}

class RelayClient {
  constructor(userDataPath) {
    this.store = new SecureStore(path.join(userDataPath, 'credentials.bin'));
    this.cacheFile = path.join(userDataPath, 'usage-cache.json');
    this.inflight = null;
    this.renewing = null;
  }

  async status() {
    const store = await this.store.read();
    return {
      signedIn: Boolean(store && (store.accessToken || store.cookie)),
      baseUrl: store?.baseUrl || DEFAULT_BASE_URL,
      username: store?.username || '',
      loginName: store?.loginName || '',
      authMode: store?.authMode || 'password',
      rememberPassword: Boolean(store?.password)
    };
  }

  async login({ baseUrl, mode, username, password, accessToken, userId, remember } = {}) {
    const origin = normalizeBaseUrl(baseUrl);
    if (mode === 'token') {
      const token = String(accessToken || '').trim().replace(/^Bearer\s+/i, '');
      const id = String(userId || '').trim();
      if (!token || !/^\d+$/.test(id)) throw new ClientError('请填写访问令牌和数字用户 ID', 'INVALID_INPUT');
      const store = { baseUrl: origin, authMode: 'token', accessToken: token, tokenType: 'Bearer', userId: id };
      const response = await this.request(`${origin}/api/user/self`, { headers: this.headers(store), retries: 0 });
      if (response.body?.success === false) throw new ClientError(response.body.message || '访问令牌无效', 'LOGIN_FAILED');
      store.username = response.body?.data?.username || '';
      await this.store.write(store);
    } else {
      const name = String(username || '').trim();
      if (!name || !password) throw new ClientError('请输入账号和密码', 'INVALID_INPUT');
      const session = await this.passwordLogin(origin, name, String(password));
      await this.store.write({
        ...session,
        baseUrl: origin,
        authMode: 'password',
        loginName: name,
        password: remember ? String(password) : null
      });
    }
    return this.refresh();
  }

  async logout() {
    await this.store.clear();
    await fs.rm(this.cacheFile, { force: true });
    return { signedIn: false };
  }

  async passwordLogin(origin, username, password) {
    const response = await this.request(`${origin}/api/user/login?turnstile=`, {
      method: 'POST',
      body: { username, password },
      retries: 0
    });
    const payload = response.body || {};
    if (payload.success === false) throw new ClientError(payload.message || '账号或密码错误', 'LOGIN_FAILED');
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    if (data.require_2fa) {
      throw new ClientError('该账户开启了两步验证，请改用「访问令牌」方式登录', 'NEED_2FA');
    }
    const accessToken = data.access_token || data.accessToken || null;
    const cookie = cookiesFrom(response.headers);
    if (!accessToken && !cookie) throw new ClientError('登录响应中没有会话信息', 'LOGIN_FAILED');
    const user = data.user && typeof data.user === 'object' ? data.user : data;
    const session = data.session && typeof data.session === 'object' ? data.session : null;
    const id = user.id ?? data.id ?? session?.user_id ?? null;
    return {
      username: user.username || username,
      userId: id === null ? null : String(id),
      accessToken,
      tokenType: data.token_type || 'Bearer',
      accessExpiresAt: num(data.access_expires_at),
      sessionSid: session?.sid || null,
      cookie
    };
  }

  headers(store) {
    const headers = { Accept: 'application/json', 'Cache-Control': 'no-store' };
    if (store.accessToken) headers.Authorization = `${store.tokenType || 'Bearer'} ${store.accessToken}`;
    if (store.cookie) headers.Cookie = store.cookie;
    if (store.userId) headers['New-Api-User'] = store.userId;
    return headers;
  }

  // Kapibala 的 access token 有效期很短，用 refresh 接口续期；失败时若保存了
  // 密码则自动重新登录，否则提示用户重新登录。
  async renew(store) {
    if (this.renewing) return this.renewing;
    this.renewing = (async () => {
      if (store.authMode === 'token') throw authExpired('访问令牌已失效，请重新填写');
      if (store.sessionSid || store.accessExpiresAt) {
        try {
          return await this.rotate(store);
        } catch (error) {
          if (isNetworkError(error)) throw error;
        }
      }
      if (store.password && store.loginName) {
        const session = await this.passwordLogin(store.baseUrl, store.loginName, store.password)
          .catch(error => { throw isNetworkError(error) ? error : authExpired(); });
        const next = { ...store, ...session };
        await this.store.write(next);
        return next;
      }
      throw authExpired();
    })().finally(() => { this.renewing = null; });
    return this.renewing;
  }

  async rotate(store) {
    const headers = { Accept: 'application/json', 'Cache-Control': 'no-store' };
    if (store.sessionSid) headers['X-Auth-Session'] = store.sessionSid;
    if (store.cookie) headers.Cookie = store.cookie;
    const response = await this.request(`${store.baseUrl}/api/user/auth/refresh`, { method: 'POST', headers, retries: 0 });
    const data = response.body?.data;
    if (response.body?.success !== true || !data?.access_token) throw authExpired();
    const session = data.session && typeof data.session === 'object' ? data.session : null;
    const next = {
      ...store,
      accessToken: data.access_token,
      tokenType: data.token_type || store.tokenType || 'Bearer',
      accessExpiresAt: num(data.access_expires_at),
      sessionSid: session?.sid || store.sessionSid,
      userId: String(data.user?.id ?? store.userId ?? '') || null,
      cookie: mergeCookies(store.cookie, cookiesFrom(response.headers))
    };
    await this.store.write(next);
    return next;
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this.load().catch(async error => {
      const store = await this.store.read();
      if (error.code === 'AUTH_EXPIRED') {
        return { signedIn: false, expired: true, message: error.message, baseUrl: store?.baseUrl, username: store?.username || '' };
      }
      const cache = await this.readCache(store);
      if (cache?.dashboard) return { ...cache.dashboard, stale: true, message: error.message };
      throw error;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async load() {
    const result = await this.withSession(store => this.fetchDashboard(store));
    return result || { signedIn: false };
  }

  // 带登录态执行一次请求：令牌快过期先续期；遇到 401/403 续期后重试一次
  async withSession(task) {
    let store = await this.store.read();
    if (!store || (!store.accessToken && !store.cookie)) return null;
    if (store.accessExpiresAt && store.accessExpiresAt * 1000 < Date.now() + 60000) {
      store = await this.renew(store);
    }
    try {
      return await task(store);
    } catch (error) {
      if (!isAuthError(error)) throw error;
      const renewed = await this.renew(store);
      try {
        return await task(renewed);
      } catch (retryError) {
        throw isAuthError(retryError) ? authExpired() : retryError;
      }
    }
  }

  // 站点货币配置（额度 → 金额的换算），10 分钟内复用
  async siteCurrency(base) {
    if (this.site && this.site.base === base && Date.now() - this.site.at < 600000) return this.site.value;
    const response = await this.request(`${base}/api/status`, { headers: { Accept: 'application/json' } }).catch(() => null);
    const site = response?.body?.data || {};
    const displayType = String(site.quota_display_type || 'USD').toUpperCase();
    const value = { site, quotaPerUnit: num(site.quota_per_unit) || 500000, rate: 1, symbol: '$', currency: 'USD' };
    if (displayType === 'CNY') {
      Object.assign(value, { rate: num(site.usd_exchange_rate) || 7.3, symbol: '¥', currency: 'CNY' });
    } else if (displayType === 'CUSTOM') {
      Object.assign(value, { rate: num(site.custom_currency_exchange_rate) || 1, symbol: String(site.custom_currency_symbol || '¤'), currency: 'CUSTOM' });
    }
    if (response) this.site = { base, at: Date.now(), value };
    return value;
  }

  // 使用日志：与站点「使用日志」页相同的数据与筛选条件
  async logs(query = {}) {
    const result = await this.withSession(async store => {
      const base = store.baseUrl;
      const headers = this.headers(store);
      const { quotaPerUnit, rate, symbol } = await this.siteCurrency(base);
      const money = quota => (quota / quotaPerUnit) * rate;
      const page = Math.max(1, int(query.page) || 1);
      const pageSize = [10, 20, 50, 100].includes(int(query.pageSize)) ? int(query.pageSize) : 20;
      const filters = new URLSearchParams({
        type: String(Math.max(0, int(query.type) || 0)),
        model_name: String(query.model || '').trim(),
        token_name: String(query.token || '').trim(),
        start_timestamp: String(int(query.start) || ''),
        end_timestamp: String(int(query.end) || ''),
        group: ''
      });
      const [listResult, statResult] = await Promise.allSettled([
        this.request(`${base}/api/log/self?p=${page}&page_size=${pageSize}&${filters}`, { headers }),
        this.request(`${base}/api/log/self/stat?${filters}`, { headers })
      ]);
      if (listResult.status === 'rejected') throw listResult.reason;
      const body = listResult.value.body || {};
      if (body.success === false) throw new ClientError(body.message || '日志接口返回失败', 'API_ERROR');
      const data = body.data || {};
      const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
      const statData = statResult.status === 'fulfilled' && statResult.value.body?.success !== false
        ? statResult.value.body?.data || {}
        : null;
      return {
        signedIn: true,
        symbol,
        page,
        pageSize,
        total: int(data.total) ?? items.length,
        items: items.map(item => parseLog(item, money)),
        stat: statData && { spent: money(num(statData.quota) || 0), rpm: num(statData.rpm), tpm: num(statData.tpm) }
      };
    });
    return result || { signedIn: false };
  }

  async fetchDashboard(store) {
    const base = store.baseUrl;
    const headers = this.headers(store);
    const get = route => this.request(`${base}${route}`, { headers });
    const now = new Date();
    const today = startOfDay(now);
    const week = startOfWeek(now);

    const { site, quotaPerUnit, rate, symbol, currency } = await this.siteCurrency(base);
    const money = quota => (quota === null || quota === undefined ? null : (quota / quotaPerUnit) * rate);

    const [userResult, subsResult, plansResult, todayStatResult, weekStatResult] = await Promise.allSettled([
      get('/api/user/self'),
      get('/api/subscription/self'),
      get('/api/subscription/plans'),
      get(`/api/log/self/stat?type=2&start_timestamp=${unix(today)}&end_timestamp=${unix(now)}`),
      get(`/api/log/self/stat?type=2&start_timestamp=${unix(week)}&end_timestamp=${unix(now)}`)
    ]);
    if (userResult.status === 'rejected') throw userResult.reason;
    const userBody = userResult.value.body || {};
    if (userBody.success === false) throw new ClientError(userBody.message || '账户接口返回失败', 'API_ERROR');
    const user = userBody.data?.user || userBody.data || {};
    const remaining = num(pick(user, ['quota', 'remain_quota']));
    const used = num(pick(user, ['used_quota']));
    const account = {
      username: user.username || store.username || '',
      displayName: user.display_name || user.username || '',
      group: user.group || '',
      balance: money(remaining),
      used: money(used),
      total: remaining !== null && used !== null ? money(remaining + used) : null,
      requests: int(user.request_count)
    };

    const stat = result => {
      if (result.status !== 'fulfilled' || result.value.body?.success === false) return null;
      const data = result.value.body?.data || {};
      return { spent: money(num(data.quota)), rpm: num(data.rpm), tpm: num(data.tpm) };
    };
    const todayStat = stat(todayStatResult);
    const weekStat = stat(weekStatResult);

    const subscriptions = parseSubscriptions(
      subsResult.status === 'fulfilled' ? subsResult.value.body?.data : null,
      plansResult.status === 'fulfilled' ? plansResult.value.body?.data : null,
      money
    );

    // ── 历史用量：按小时聚合，增量同步并缓存在本地 ──────────────────────────
    const historyStart = startOfWeek(new Date(today.getTime() - (HEATMAP_WEEKS - 1) * 7 * DAY));
    const cache = await this.readCache(store);
    const cachedRows = (cache?.rows || []).filter(row => row[0] >= unix(historyStart));
    const syncedTo = num(cache?.syncedTo);
    const syncFrom = syncedTo && syncedTo * 1000 > historyStart.getTime()
      ? new Date(Math.max(historyStart.getTime(), startOfDay(new Date(syncedTo * 1000 - OVERLAP_DAYS * DAY)).getTime()))
      : historyStart;
    let rows = cachedRows;
    let historyMode = 'aggregate';
    let historyError = null;
    try {
      const fresh = await this.fetchBuckets(base, headers, syncFrom, now);
      rows = cachedRows.filter(row => row[0] < unix(syncFrom)).concat(fresh);
    } catch (error) {
      if (isAuthError(error)) throw error;
      historyError = error;
      // 站点关闭了 /api/data/self 时，用明细日志补齐本周数据
      try {
        const logs = await this.fetchLogs(base, headers, week, now);
        rows = cachedRows.filter(row => row[0] < unix(week)).concat(logs);
        historyMode = 'logs';
        historyError = null;
      } catch (fallbackError) {
        if (isAuthError(fallbackError)) throw fallbackError;
      }
    }
    rows.sort((a, b) => a[0] - b[0]);

    const usage = aggregate(rows, { now, today, week, historyStart, money });
    // 聚合数据有几分钟延迟，标题数字优先使用实时 stat 接口
    if (todayStat?.spent !== null && todayStat?.spent !== undefined) usage.today.spent = todayStat.spent;
    if (weekStat?.spent !== null && weekStat?.spent !== undefined) usage.week.spent = weekStat.spent;

    const dashboard = {
      signedIn: true,
      baseUrl: base,
      host: new URL(base).host,
      siteName: site.system_name || new URL(base).host,
      username: account.username,
      fetchedAt: now.toISOString(),
      currency,
      symbol,
      account,
      live: { rpm: todayStat?.rpm ?? null, tpm: todayStat?.tpm ?? null },
      ...usage,
      subscriptions,
      subscriptionSummary: {
        count: subscriptions.length,
        total: subscriptions.reduce((sum, item) => sum + item.total, 0),
        used: subscriptions.reduce((sum, item) => sum + item.used, 0),
        remaining: subscriptions.reduce((sum, item) => sum + item.remaining, 0),
        nearestEnd: subscriptions.map(item => item.endAt).filter(Boolean).sort((a, b) => a - b)[0] || null
      },
      history: { mode: historyMode, ok: !historyError, message: historyError?.message || '' },
      stale: false
    };
    await this.writeCache(store, { syncedTo: historyError ? syncedTo : unix(now), rows, dashboard });
    return dashboard;
  }

  async fetchBuckets(base, headers, start, end) {
    const chunks = [];
    for (let cursor = start.getTime(); cursor < end.getTime(); cursor += CHUNK_DAYS * DAY) {
      chunks.push([new Date(cursor), new Date(Math.min(end.getTime(), cursor + CHUNK_DAYS * DAY - 1000))]);
    }
    const rows = [];
    for (let i = 0; i < chunks.length; i += 3) {
      const results = await Promise.all(chunks.slice(i, i + 3).map(async ([from, to]) => {
        const response = await this.request(
          `${base}/api/data/self?start_timestamp=${unix(from)}&end_timestamp=${unix(to)}`, { headers }
        );
        if (response.body?.success === false) {
          throw new ClientError(response.body.message || '历史聚合接口不可用', 'HISTORY_UNAVAILABLE');
        }
        const data = response.body?.data;
        const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : null);
        if (!list) throw new ClientError('历史聚合接口返回格式不正确', 'HISTORY_UNAVAILABLE');
        return list;
      }));
      for (const list of results) {
        for (const item of list) {
          const ts = toUnix(item.created_at);
          if (ts === null) continue;
          rows.push([ts, String(item.model_name || 'unknown'), num(item.quota) || 0, int(item.token_used) || 0, int(item.count) || 0]);
        }
      }
    }
    // 相邻区间的边界小时可能重复返回
    const seen = new Map();
    for (const row of rows) seen.set(`${row[0]}|${row[1]}`, row);
    return [...seen.values()];
  }

  async fetchLogs(base, headers, start, end) {
    const buckets = new Map();
    for (let page = 1; page <= LOG_MAX_PAGES; page += 1) {
      const response = await this.request(
        `${base}/api/log/self?type=2&p=${page}&page_size=${LOG_PAGE_SIZE}&start_timestamp=${unix(start)}&end_timestamp=${unix(end)}`,
        { headers }
      );
      if (response.body?.success === false) throw new ClientError(response.body.message || '日志接口不可用', 'HISTORY_UNAVAILABLE');
      const data = response.body?.data || {};
      const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
      for (const item of items) {
        const ts = toUnix(item.created_at);
        if (ts === null) continue;
        const hour = ts - (ts % 3600);
        const model = String(item.model_name || 'unknown');
        const key = `${hour}|${model}`;
        const row = buckets.get(key) || [hour, model, 0, 0, 0];
        row[2] += num(item.quota) || 0;
        row[3] += (int(item.prompt_tokens) || 0) + (int(item.completion_tokens) || 0);
        row[4] += 1;
        buckets.set(key, row);
      }
      const total = int(data.total);
      if (items.length < LOG_PAGE_SIZE || (total !== null && page * LOG_PAGE_SIZE >= total)) break;
    }
    return [...buckets.values()];
  }

  cacheKey(store) {
    return `${store?.baseUrl}|${store?.userId || store?.username || ''}`;
  }

  async readCache(store) {
    try {
      const cache = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
      return cache.key === this.cacheKey(store) ? cache : null;
    } catch {
      return null;
    }
  }

  async writeCache(store, value) {
    try {
      await fs.writeFile(this.cacheFile, JSON.stringify({ key: this.cacheKey(store), ...value }), 'utf8');
    } catch { /* 缓存只是加速，失败不影响使用 */ }
  }

  async request(url, { headers = {}, method = 'GET', body, retries = 2 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const init = { method, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }, signal: controller.signal, redirect: 'error' };
        if (body !== undefined) {
          init.body = JSON.stringify(body);
          init.headers['Content-Type'] = 'application/json';
        }
        const response = await fetch(url, init);
        const text = await response.text();
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch {
          throw new ClientError(response.ok ? '站点返回了无法解析的数据' : `请求失败（HTTP ${response.status}）`, 'INVALID_RESPONSE', response.status);
        }
        if (!response.ok) {
          throw new ClientError(parsed?.message || `请求失败（HTTP ${response.status}）`, `HTTP_${response.status}`, response.status);
        }
        return { body: parsed, headers: response.headers, status: response.status };
      } catch (error) {
        if (error.name === 'AbortError') lastError = new ClientError('请求超时，请检查网络', 'TIMEOUT');
        else if (error instanceof ClientError) lastError = error;
        else lastError = new ClientError('无法连接站点，请检查网络或地址', 'NETWORK_ERROR');
        const status = lastError.status;
        const retryable = !status || status >= 500 || status === 429 || status === 408;
        if (!retryable || attempt >= retries) throw lastError;
        await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

function aggregate(rows, { now, today, week, historyStart, money }) {
  const todayTs = unix(today);
  const weekTs = unix(week);
  const empty = () => ({ spent: 0, tokens: 0, requests: 0 });
  const hourly = Array.from({ length: 24 }, empty);
  const daily = new Map();
  const modelsToday = new Map();
  const modelsWeek = new Map();
  const modelsMonth = new Map();
  const monthTs = unix(new Date(today.getTime() - 29 * DAY));
  const totals = empty();
  const todayTotals = empty();
  const weekTotals = empty();

  const addModel = (map, row) => {
    const item = map.get(row[1]) || { model: row[1], spent: 0, tokens: 0, requests: 0 };
    item.spent += money(row[2]);
    item.tokens += row[3];
    item.requests += row[4];
    map.set(row[1], item);
  };
  const add = (target, row) => {
    target.spent += money(row[2]);
    target.tokens += row[3];
    target.requests += row[4];
  };

  for (const row of rows) {
    const date = new Date(row[0] * 1000);
    const key = dayKey(date);
    const day = daily.get(key) || empty();
    add(day, row);
    daily.set(key, day);
    add(totals, row);
    if (row[0] >= monthTs) addModel(modelsMonth, row);
    if (row[0] >= weekTs) {
      add(weekTotals, row);
      addModel(modelsWeek, row);
    }
    if (row[0] >= todayTs) {
      add(todayTotals, row);
      add(hourly[date.getHours()], row);
      addModel(modelsToday, row);
    }
  }

  const days = [];
  for (const cursor = new Date(historyStart); cursor <= now; cursor.setDate(cursor.getDate() + 1)) {
    const key = dayKey(cursor);
    days.push({ date: key, ...(daily.get(key) || empty()) });
  }
  const weekDays = [];
  for (let i = 0; i < 7; i += 1) {
    const date = new Date(week);
    date.setDate(week.getDate() + i);
    const key = dayKey(date);
    weekDays.push({ date: key, future: date > now, ...(daily.get(key) || empty()) });
  }
  const sortModels = map => {
    const list = [...map.values()].sort((a, b) => b.spent - a.spent || b.tokens - a.tokens);
    const total = list.reduce((sum, item) => sum + item.spent, 0) || 1;
    return list.map(item => ({ ...item, share: item.spent / total }));
  };

  return {
    today: { ...todayTotals, hourly, currentHour: now.getHours() },
    week: { ...weekTotals, days: weekDays },
    heatmap: { start: dayKey(historyStart), days },
    totals: { ...totals, since: dayKey(historyStart) },
    models: { today: sortModels(modelsToday), week: sortModels(modelsWeek), month: sortModels(modelsMonth) }
  };
}

function collectObjects(value, out = []) {
  if (Array.isArray(value)) value.forEach(item => collectObjects(item, out));
  else if (value && typeof value === 'object') {
    out.push(value);
    Object.values(value).forEach(item => collectObjects(item, out));
  }
  return out;
}

const LOG_TYPES = { 1: '充值', 2: '消费', 3: '管理', 4: '系统', 5: '错误', 6: '退款' };

function parseLog(item, money) {
  let other = {};
  if (item.other && typeof item.other === 'object') other = item.other;
  else if (typeof item.other === 'string' && item.other) {
    try { other = JSON.parse(item.other) || {}; } catch { other = {}; }
  }
  const type = int(item.type) || 0;
  const quota = num(item.quota) || 0;
  const frt = num(other.frt);
  return {
    id: String(item.id ?? `${item.created_at}-${item.model_name}`),
    at: toUnix(item.created_at),
    type,
    typeName: LOG_TYPES[type] || '其他',
    model: String(item.model_name || ''),
    token: String(item.token_name || ''),
    group: String(item.group || other.group || ''),
    stream: Boolean(item.is_stream),
    useTime: num(item.use_time),
    firstToken: frt !== null && frt > 0 ? frt / 1000 : null,
    prompt: int(item.prompt_tokens) || 0,
    completion: int(item.completion_tokens) || 0,
    cacheRead: int(other.cache_tokens) || 0,
    cacheWrite: int(other.cache_creation_tokens) || 0,
    quota,
    cost: money(quota),
    modelRatio: num(other.model_ratio),
    groupRatio: num(other.group_ratio),
    completionRatio: num(other.completion_ratio),
    modelPrice: num(other.model_price),
    reasoning: String(other.reasoning_effort || ''),
    content: String(item.content || '').slice(0, 500),
    ip: String(item.ip || '')
  };
}

function parseSubscriptions(subsData, plansData, money) {
  const titles = new Map();
  for (const item of collectObjects(plansData)) {
    const id = int(item.id ?? item.plan_id);
    const title = item.title || item.name;
    if (id !== null && title && typeof title === 'string') titles.set(id, title);
  }
  const nowSec = Date.now() / 1000;
  const seen = new Set();
  const result = [];
  for (const item of collectObjects(subsData)) {
    if (!('amount_total' in item) && !('total_amount' in item)) continue;
    const id = String(item.id ?? `${item.plan_id}:${item.start_time}:${item.end_time}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const status = String(item.status ?? 'active').toLowerCase();
    const endAt = toUnix(item.end_time ?? item.expires_at);
    if (status !== 'active' || (endAt && endAt < nowSec)) continue;
    const total = money(num(item.amount_total ?? item.total_amount) || 0);
    const used = money(num(item.amount_used ?? item.used_amount) || 0);
    const planId = int(item.plan_id);
    result.push({
      id,
      title: (planId !== null && titles.get(planId)) || item.title || item.name || `订阅 ${result.length + 1}`,
      total,
      used,
      remaining: Math.max(0, total - used),
      ratio: total > 0 ? Math.max(0, Math.min(1, (total - used) / total)) : 0,
      startAt: toUnix(item.start_time),
      endAt
    });
  }
  return result.sort((a, b) => (a.endAt || Infinity) - (b.endAt || Infinity));
}

module.exports = { RelayClient, ClientError, DEFAULT_BASE_URL };
