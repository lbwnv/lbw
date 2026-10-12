// 端到端测试：本地模拟一个 New API 站点，跑通 登录 → 刷新 → 令牌续期 → 缓存 → 退出
const { app } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// 运行：npm test（不会访问任何真实站点）
const { RelayClient } = require('../src/client.cjs');

const now = Math.floor(Date.now() / 1000);
let tokenVersion = 1;
let lastLogQuery = null;
const calls = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  calls.push(`${req.method} ${url.pathname}`);
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const authed = req.headers.authorization === `Bearer tok${tokenVersion}` && req.headers['new-api-user'] === '7';
  if (url.pathname === '/api/status') return send(200, { success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7, system_name: 'Mock' } });
  if (url.pathname === '/api/user/login') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { username, password } = JSON.parse(body);
      if (username !== 'alice' || password !== 'pw') return send(200, { success: false, message: '用户名或密码错误' });
      send(200, { success: true, data: { id: 7, username: 'alice', access_token: `tok${tokenVersion}`, access_expires_at: now + 3600, session: { sid: 'sid1', user_id: 7 } } }, { 'Set-Cookie': 'session=abc; Path=/; HttpOnly' });
    });
    return;
  }
  if (url.pathname === '/api/user/auth/refresh') {
    if (req.headers['x-auth-session'] !== 'sid1') return send(401, { success: false });
    tokenVersion += 1;
    return send(200, { success: true, data: { access_token: `tok${tokenVersion}`, access_expires_at: now + 3600, user: { id: 7, username: 'alice' } } });
  }
  if (!authed) return send(401, { success: false, message: 'unauthorized' });
  if (url.pathname === '/api/user/self') return send(200, { success: true, data: { id: 7, username: 'alice', display_name: 'Alice', group: 'vip', quota: 5000000, used_quota: 2500000, request_count: 321 } });
  if (url.pathname === '/api/subscription/self') return send(200, { success: true, data: { subscriptions: [{ subscription: { id: 1, plan_id: 3, status: 'active', amount_total: 1000000, amount_used: 250000, start_time: now - 86400, end_time: now + 5 * 86400 } }, { subscription: { id: 2, plan_id: 3, status: 'expired', amount_total: 1, amount_used: 0, end_time: now - 10 } }] } });
  if (url.pathname === '/api/subscription/plans') return send(200, { success: true, data: [{ plan: { id: 3, title: 'Coding Plan Max' } }] });
  if (url.pathname === '/api/log/self/stat') return send(200, { success: true, data: { quota: 100000, rpm: 2, tpm: 900 } });
  if (url.pathname === '/api/log/self') {
    lastLogQuery = Object.fromEntries(url.searchParams);
    return send(200, { success: true, data: { total: 45, items: [
      { id: 11, created_at: now - 30, type: 2, model_name: 'claude-sonnet-4-5', token_name: 'cc', prompt_tokens: 1000, completion_tokens: 200, quota: 25000, use_time: 4, is_stream: true, other: JSON.stringify({ frt: 850, cache_tokens: 700, model_ratio: 1.5, group_ratio: 1, completion_ratio: 5 }) },
      { id: 12, created_at: now - 60, type: 5, model_name: '', content: 'upstream error', quota: 0 }
    ] } });
  }
  if (url.pathname === '/api/data/self') {
    const s = +url.searchParams.get('start_timestamp'), e = +url.searchParams.get('end_timestamp');
    const rows = [];
    for (let t = now - 3600; t > s; t -= 86400 * 3) if (t <= e) rows.push({ created_at: t - (t % 3600), model_name: t > now - 86400 * 10 ? 'claude-sonnet-4-5' : 'gpt-5', quota: 50000, token_used: 1200, count: 3 });
    return send(200, { success: true, data: rows });
  }
  send(404, { success: false });
});

function assert(cond, msg) { if (!cond) { console.log('FAIL:', msg); process.exitCode = 1; } else console.log('ok  -', msg); }

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-e2e-'));
  const client = new RelayClient(dir);
  try {
    await client.login({ baseUrl: base, username: 'alice', password: 'bad' }).then(() => assert(false, 'bad password rejected'), e => assert(e.message === '用户名或密码错误', `bad password rejected (${e.message})`));
    const d = await client.login({ baseUrl: base, username: 'alice', password: 'pw', remember: true });
    assert(d.signedIn && d.username === 'alice', 'login + dashboard');
    assert(d.symbol === '¥' && Math.abs(d.account.balance - 70) < 1e-9, `CNY balance = ${d.account.balance}`);
    assert(Math.abs(d.account.total - 105) < 1e-9, `total = ${d.account.total}`);
    assert(d.subscriptions.length === 1 && d.subscriptions[0].title === 'Coding Plan Max', 'active subscription with plan title');
    assert(Math.abs(d.subscriptions[0].remaining - 10.5) < 1e-9, `subscription remaining = ${d.subscriptions[0].remaining}`);
    assert(Math.abs(d.today.spent - 1.4) < 1e-9, `today spent from stat = ${d.today.spent}`);
    assert(d.heatmap.days.length >= 365 && d.heatmap.days.some(x => x.requests > 0), `heatmap days = ${d.heatmap.days.length}`);
    assert(d.models.month.length >= 1 && d.history.ok, 'models + history ok');
    const raw = fs.readFileSync(path.join(dir, 'credentials.bin'), 'utf8');
    const bytes = Buffer.from(raw, 'base64').toString('latin1');
    assert(!bytes.includes('"pw"') && !bytes.includes('tok1') && !bytes.includes('alice'), 'credentials encrypted on disk');

    // 模拟令牌在服务端失效 → 自动续期
    tokenVersion = 5;
    const before = calls.length;
    const d2 = await client.refresh();
    assert(d2.signedIn && !d2.stale, 'auto renew after 401');
    assert(calls.slice(before).includes('POST /api/user/auth/refresh'), 'used refresh endpoint');
    const dataCalls = calls.slice(before).filter(c => c.includes('/api/data/self')).length;
    assert(dataCalls <= 2, `incremental history sync (${dataCalls} chunk requests)`);

    // 使用日志
    tokenVersion = 9;
    const logs = await client.logs({ page: 3, pageSize: 20, type: 2, model: 'claude', token: 'cc', start: now - 3600, end: now });
    assert(logs.signedIn && logs.total === 45 && logs.items.length === 2, 'logs list (after auto renew)');
    assert(lastLogQuery.p === '3' && lastLogQuery.page_size === '20' && lastLogQuery.type === '2' && lastLogQuery.model_name === 'claude' && lastLogQuery.token_name === 'cc', 'logs filters forwarded');
    const first = logs.items[0];
    assert(Math.abs(first.cost - 0.35) < 1e-9 && first.firstToken === 0.85 && first.cacheRead === 700 && first.typeName === '消费', `log parsed (cost ${first.cost})`);
    assert(logs.items[1].typeName === '错误' && logs.items[1].content === 'upstream error', 'error log parsed');
    assert(logs.symbol === '¥' && Math.abs(logs.stat.spent - 1.4) < 1e-9, 'log stat');

    // 断网 → 返回缓存
    server.close(); server.closeAllConnections?.();
    const d3 = await client.refresh();
    assert(d3.stale && d3.signedIn, 'offline falls back to cache');

    await client.logout();
    assert(!fs.existsSync(path.join(dir, 'credentials.bin')) && !fs.existsSync(path.join(dir, 'usage-cache.json')), 'logout wipes local data');
    assert(!(await client.status()).signedIn, 'signed out');
    let threw = false; try { await new RelayClient(dir).login({ baseUrl: 'http://example.com', username: 'a', password: 'b' }); } catch (e) { threw = e.code === 'INVALID_URL'; }
    assert(threw, 'plain http rejected for remote hosts');
  } catch (e) {
    console.log('ERROR', e);
    process.exitCode = 1;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
