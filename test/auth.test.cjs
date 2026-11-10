// Signing in and out, device-flow polling, token refresh, and the config page protocol.
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, CLIENT_ID, MIN, HOUR } = require('./world.cjs');

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const at = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const DAY = 24 * HOUR;

function library(w) {
  w.setItem('shows', 100, 'The Show', 'watching');
  w.tvEpisode(100, 1, 1, at(NOW + DAY));
}
function signedIn() {
  const w = createWorld();
  w.signIn();
  w.setSettings({});
  library(w);
  return w;
}
const tokenCalls = (w) => w.calls.filter((c) => c.path === '/oauth2/token');
const secureTokens = (w) => (w.secure.has('tokens') ? JSON.parse(w.secure.get('tokens')) : null);

// ---------------------------------------------------------------- device flow

test('sign-in start shows the code and keeps the device code only in secure storage', async () => {
  const w = createWorld();
  const r = await w.action('signin_start');
  assert.deepStrictEqual(r, { ok: true, text: 'ABCD-EFGH' });
  const call = w.calls[0];
  assert.strictEqual(call.path, '/oauth2/device');
  assert.strictEqual(call.method, 'POST');
  assert.strictEqual(call.form.scope, 'media:read media:write');
  assert.strictEqual(call.form.client_id, '0c2ba84016dd0ef96cb51b3dd5d77eaff1597be12102c28f089e08e3c846235e');

  assert.deepStrictEqual(w.store('signin'), { userCode: 'ABCD-EFGH', uri: 'https://simkl.com/pin', uriComplete: 'https://simkl.com/pin?user_code=ABCD-EFGH', expiresAt: NOW + 900000, interval: 5 });
  assert.strictEqual(w.secure.get('device_code'), 'dev-secret-1');
  for (const [key, value] of w.local) assert.ok(!value.includes('dev-secret-1'), key + ' holds the device code');
});

test('starting again while the code is live shows the same code without a new request', async () => {
  const w = createWorld();
  await w.action('signin_start');
  w.resetCalls();
  w.advance(2 * MIN);
  assert.strictEqual((await w.action('signin_start')).text, 'ABCD-EFGH');
  assert.strictEqual(w.calls.length, 0);
});

test('the plugin keeps the poll spacing itself, however fast the caller asks', async () => {
  const w = createWorld();
  await w.action('signin_start');
  w.resetCalls();
  for (let i = 0; i < 5; i++) assert.strictEqual((await w.action('signin_poll')).text, 'pending');
  assert.strictEqual(tokenCalls(w).length, 0, 'inside the first five seconds');

  w.advance(5000);
  for (let i = 0; i < 5; i++) assert.strictEqual((await w.action('signin_poll')).text, 'pending');
  assert.strictEqual(tokenCalls(w).length, 1, 'one request for ten polls in the same instant');
  assert.strictEqual(tokenCalls(w)[0].form.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.strictEqual(tokenCalls(w)[0].form.device_code, 'dev-secret-1');
});

test('slow_down adds five seconds and the wait is real', async () => {
  const w = createWorld();
  await w.action('signin_start');
  w.advance(5000);
  w.sim.device.answer = { status: 400, json: { error: 'slow_down' } };
  w.resetCalls();
  assert.strictEqual((await w.action('signin_poll')).text, 'pending');
  assert.strictEqual(tokenCalls(w).length, 1);
  assert.strictEqual(w.store('signin').interval, 10);

  w.sim.device.answer = null;
  w.advance(5000);
  await w.action('signin_poll');
  assert.strictEqual(tokenCalls(w).length, 1, 'five seconds after a slow_down is still too soon');
  w.advance(5000);
  await w.action('signin_poll');
  assert.strictEqual(tokenCalls(w).length, 2);
});

test('approval stores the tokens and the name, and clears the code', async () => {
  const w = createWorld();
  await w.action('signin_start');
  w.advance(5000);
  w.sim.device.approved = true;
  w.resetCalls();
  assert.deepStrictEqual(await w.action('signin_poll'), { ok: true, text: 'approved' });
  const tokens = secureTokens(w);
  assert.strictEqual(tokens.access, 'at1');
  assert.strictEqual(tokens.refresh, 'rt1');
  assert.ok(Math.abs(tokens.expiresAt - (w.clock.now + 7 * DAY)) < 1000);
  assert.deepStrictEqual(w.store('account'), { name: 'syl' });
  assert.strictEqual(w.store('signin'), null);
  assert.strictEqual(w.secure.has('device_code'), false);
  const settings = w.calls.find((c) => c.path === '/users/settings');
  assert.strictEqual(settings.method, 'POST');
  assert.strictEqual(settings.headers.Authorization, 'Bearer at1');
});

test('a token without write access is refused and revoked, with nothing stored', async () => {
  const w = createWorld();
  await w.action('signin_start');
  w.advance(5000);
  w.sim.device.approved = true;
  w.sim.tokenScope = 'media:read';
  const r = await w.action('signin_poll');
  assert.strictEqual(r.error.code, 'UNKNOWN');
  assert.match(r.error.message, /marking episodes as watched/);
  assert.strictEqual(secureTokens(w), null);
  assert.strictEqual(w.store('account'), null);
  assert.ok(w.calls.some((c) => c.path === '/oauth2/revoke' && c.form.token === 'rt1'));
  assert.strictEqual(w.store('signin'), null);
});

test('the code expires on our own clock, since Simkl never reports a refusal', async () => {
  const w = createWorld();
  await w.action('signin_start');
  w.advance(899 * 1000);
  w.resetCalls();
  assert.strictEqual((await w.action('signin_poll')).text, 'pending');
  assert.strictEqual(tokenCalls(w).length, 1);
  w.advance(2000);
  w.resetCalls();
  assert.strictEqual((await w.action('signin_poll')).text, 'expired');
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(w.store('signin'), null);
  assert.strictEqual(w.secure.has('device_code'), false);
});

test('expired_token from Simkl ends the attempt, and polling with nothing started says expired', async () => {
  const w = createWorld();
  assert.strictEqual((await w.action('signin_poll')).text, 'expired');
  await w.action('signin_start');
  w.advance(5000);
  w.sim.device.answer = { status: 400, json: { error: 'expired_token' } };
  assert.strictEqual((await w.action('signin_poll')).text, 'expired');
  assert.strictEqual(w.store('signin'), null);
});

test('a sign-in as a different Simkl user starts from a clean slate', async () => {
  const w = signedIn();
  await w.syncAll('manual');
  assert.strictEqual(w.pinIds().length, 1);
  w.secure.delete('tokens');
  w.sim.user.name = 'someone-else';
  await w.action('signin_start');
  w.advance(5000);
  w.sim.device.approved = true;
  await w.action('signin_poll');
  assert.deepStrictEqual(w.pinIds(), []);
  assert.strictEqual(w.store('plugin.lists'), null);
});

// ---------------------------------------------------------------- tokens

test('a token within a day of expiry is refreshed once, and the new one is used and stored', async () => {
  const w = signedIn();
  w.signIn({ expiresAt: NOW + 23 * HOUR });
  await w.syncAll('manual');
  assert.strictEqual(tokenCalls(w).length, 1);
  assert.strictEqual(tokenCalls(w)[0].form.grant_type, 'refresh_token');
  assert.strictEqual(tokenCalls(w)[0].form.refresh_token, 'rt1');
  const authed = w.calls.filter((c) => c.path.startsWith('/sync/'));
  assert.ok(authed.length > 0 && authed.every((c) => c.headers.Authorization === 'Bearer at2'));
  assert.strictEqual(secureTokens(w).access, 'at2');
  assert.ok(secureTokens(w).expiresAt > NOW + 6 * DAY);

  const fresh = signedIn();
  fresh.signIn({ expiresAt: NOW + 25 * HOUR });
  await fresh.syncAll('manual');
  assert.strictEqual(tokenCalls(fresh).length, 0);
});

test('on a 401 the stored token is read again first: if another invocation refreshed, its token is used and nothing is refreshed', async () => {
  const w = signedIn();
  w.sim.validAccess = new Set(['at9']);
  w.hook = (call) => {
    if (call.headers.Authorization === 'Bearer at1') {
      w.secure.set('tokens', JSON.stringify({ access: 'at9', refresh: 'rt1', expiresAt: NOW + 7 * DAY, scope: 'media:read media:write' }));
      return w.response(401, { error: 'invalid_token' });
    }
    return undefined;
  };
  assert.strictEqual((await w.syncAll('manual')).text, 'done');
  assert.strictEqual(tokenCalls(w).length, 0);
  assert.ok(w.pinIds().includes('tv-100-1-1'));
});

test('on a 401 with an unchanged token, it is refreshed and the request retried', async () => {
  const w = signedIn();
  w.sim.validAccess = new Set();
  assert.strictEqual((await w.syncAll('manual')).text, 'done');
  const order = w.calls.filter((c) => c.path === '/sync/activities' || c.path === '/oauth2/token').map((c) => c.path + ' ' + (c.headers.Authorization || ''));
  assert.deepStrictEqual(order.slice(0, 3), ['/sync/activities Bearer at1', '/oauth2/token ', '/sync/activities Bearer at2']);
});

test('while another invocation holds the refresh lock, this one waits for its token instead of refreshing', async () => {
  const w = signedIn();
  w.signIn({ expiresAt: NOW + HOUR });
  w.setStore('plugin.refreshLock', NOW + 10000);
  w.sim.validAccess = new Set(['at7']);
  w.onSleep = () => w.secure.set('tokens', JSON.stringify({ access: 'at7', refresh: 'rt1', expiresAt: w.clock.now + 7 * DAY, scope: 'media:read media:write' }));
  assert.strictEqual((await w.syncAll('manual')).text, 'done');
  assert.strictEqual(tokenCalls(w).length, 0);
  assert.ok(w.calls.filter((c) => c.path.startsWith('/sync/')).every((c) => c.headers.Authorization === 'Bearer at7'));
});

test('when Simkl ends the grant, the user is signed out and told to sign in again', async () => {
  const w = signedIn();
  w.sim.validAccess = new Set();
  w.sim.refreshToken = 'something-else';
  const r = await w.action('sync', { reason: 'manual' });
  assert.strictEqual(r.error.code, 'AUTH_REQUIRED');
  assert.strictEqual(secureTokens(w), null);
  assert.strictEqual(w.store('account'), null);
  assert.strictEqual(w.store('sync_status').state, 'signed_out');
});

test('a 401 that survives a refresh signs the user out instead of looping', async () => {
  const w = signedIn();
  w.sim.validAccess = new Set();
  w.sim.nextAccess = 'never-valid';
  w.hook = (call) => (call.path === '/oauth2/token' ? w.response(200, { access_token: 'x', refresh_token: 'rt1', expires_in: 3600 }) : undefined);
  const r = await w.action('sync', { reason: 'manual' });
  assert.strictEqual(r.error.code, 'AUTH_REQUIRED');
  assert.strictEqual(tokenCalls(w).length, 1);
  assert.strictEqual(w.store('account'), null);
});

// ---------------------------------------------------------------- config page

test('state reports the account, settings, status, permissions and version', async () => {
  const w = signedIn();
  w.permissions['Internet/data.simkl.in'] = 'prompt';
  const s = await w.config({ type: 'state' });
  assert.deepStrictEqual(s.account, { name: 'syl' });
  assert.strictEqual(s.signin, null);
  assert.strictEqual(s.settings.daysAhead, 14);
  assert.deepStrictEqual(s.permissions, { simkl: 'granted', cdn: 'prompt', timeline: 'granted' });
  assert.strictEqual(s.version, '1.0.0');
});

test('state drops a sign-in code that has expired', async () => {
  const w = createWorld();
  await w.config({ type: 'signinStart' });
  assert.ok((await w.config({ type: 'state' })).signin);
  w.advance(901 * 1000);
  assert.strictEqual((await w.config({ type: 'state' })).signin, null);
  assert.strictEqual(w.secure.has('device_code'), false);
});

test('saving settings checks them, stores them, and runs the whole sync before answering', async () => {
  const w = signedIn();
  const bad = await w.config({ type: 'saveSettings', settings: { daysAhead: 5 } });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /7, 14 or 30/);
  assert.strictEqual(w.store('settings').daysAhead, 14);
  assert.strictEqual(w.calls.length, 0);

  for (const settings of [{ reminder: 20 }, { movieRelease: 'sometimes' }, { country: 'USA' }, { movieTime: '9am' }, { syncTimes: [360] }, { types: { tv: 'yes' } }]) {
    assert.strictEqual((await w.config({ type: 'saveSettings', settings })).ok, false, JSON.stringify(settings));
  }

  w.latency = 5000; // far past the 20 second limit of an action
  const saved = await w.config({ type: 'saveSettings', settings: { daysAhead: 30, country: 'de' } });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.status.ok, true);
  assert.strictEqual(saved.status.state, 'ok');
  assert.strictEqual(w.store('settings').daysAhead, 30);
  assert.strictEqual(w.store('settings').country, 'DE');
  assert.deepStrictEqual(w.pinIds(), ['tv-100-1-1']);
  assert.strictEqual(w.store('plugin.sync'), null);
});

test('saving settings while signed out keeps them and reports the sign-in problem', async () => {
  const w = createWorld();
  const saved = await w.config({ type: 'saveSettings', settings: { daysAhead: 7 } });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.status.state, 'signed_out');
  assert.strictEqual(w.store('settings').daysAhead, 7);
});

test('Sync now runs the whole sync and reports the status', async () => {
  const w = signedIn();
  w.latency = 4000;
  const r = await w.config({ type: 'syncNow' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status.pinCount, 1);
  assert.strictEqual(r.status.message, '1 item on your timeline.');
  assert.strictEqual(r.status.listsCheckedAt, w.store('plugin.listsAt'));

  w.hook = () => new TypeError('fetch failed');
  w.advance(2 * MIN);
  const failed = await w.config({ type: 'syncNow' });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.status.state, 'offline');
});

test('the page signs in: start, poll pending, then approved runs the first sync before answering', async () => {
  const w = createWorld();
  w.setSettings({});
  library(w);
  const started = await w.config({ type: 'signinStart' });
  assert.strictEqual(started.signin.userCode, 'ABCD-EFGH');
  assert.strictEqual((await w.config({ type: 'signinPoll' })).state, 'pending');
  w.advance(5000);
  w.sim.device.approved = true;
  const done = await w.config({ type: 'signinPoll' });
  assert.strictEqual(done.state, 'approved');
  assert.deepStrictEqual(done.account, { name: 'syl' });
  assert.strictEqual(done.status.ok, true);
  assert.deepStrictEqual(w.pinIds(), ['tv-100-1-1']);

  const bad = createWorld();
  await bad.config({ type: 'signinStart' });
  bad.advance(5000);
  bad.sim.device.answer = { status: 401, json: { error: 'invalid_client' } };
  const failed = await bad.config({ type: 'signinPoll' });
  assert.strictEqual(failed.state, 'error');
  assert.match(failed.error, /invalid_client/);
});

test('signing out revokes the token and removes every pin, the tokens and the lists', async () => {
  const w = signedIn();
  w.setSettings({ movieRelease: 'both' });
  w.setItem('movies', 7, 'The Movie', 'plantowatch');
  w.setMovie(7, { dates: { US: [[3, '2026-11-20'], [4, '2026-11-22']] } });
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), ['mv-7-cinema', 'mv-7-digital', 'tv-100-1-1']);

  w.resetCalls();
  const r = await w.config({ type: 'signout' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(w.pinIds(), []);
  assert.deepStrictEqual(w.phone.ops.map((o) => o.op), ['delete', 'delete', 'delete']);
  const revoke = w.calls.find((c) => c.path === '/oauth2/revoke');
  assert.strictEqual(revoke.form.token, 'rt1');
  assert.strictEqual(revoke.form.client_id, CLIENT_ID);
  assert.strictEqual(secureTokens(w), null);
  for (const key of ['account', 'plugin.lists', 'plugin.snapshot', 'upcoming', 'signin']) assert.strictEqual(w.store(key), null, key);
  assert.strictEqual(w.store('sync_status').state, 'signed_out');
  Object.values(w.store('pins')).forEach((rec) => assert.strictEqual(rec.deleted, true));
  assert.strictEqual((await w.action('sync', { reason: 'manual' })).error.code, 'AUTH_REQUIRED');
});

test('signing out still works offline: the pins and the tokens go, and the answer says the revoke did not happen', async () => {
  const w = signedIn();
  await w.syncAll('manual');
  w.hook = () => new TypeError('fetch failed');
  const r = await w.config({ type: 'signout' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.revoked, false);
  assert.deepStrictEqual(w.pinIds(), []);
  assert.strictEqual(secureTokens(w), null);
});

test('after signing out and back in, a pin comes back under a fresh id', async () => {
  const w = signedIn();
  await w.syncAll('manual');
  await w.config({ type: 'signout' });
  w.signIn();
  w.advance(2 * MIN);
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), ['tv-100-1-1-2']);
});

test('unknown messages are refused', async () => {
  const w = createWorld();
  assert.deepStrictEqual(await w.config({ type: 'nope' }), { error: 'unknown message type' });
});
