// How the watchlist and calendar are read: two-phase snapshot, throttling, resuming, caching, failures.
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, MIN, HOUR } = require('./world.cjs');

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const at = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const DAY = 24 * HOUR;

function ready(settings = {}) {
  const w = createWorld();
  w.signIn();
  w.setSettings(settings);
  w.setItem('shows', 100, 'The Show', 'watching');
  w.setItem('anime', 200, 'The Anime', 'watching');
  w.setItem('movies', 300, 'The Movie', 'plantowatch');
  w.tvEpisode(100, 1, 1, at(NOW + DAY));
  w.animeEpisode(200, null, 7, at(NOW + DAY));
  w.setMovie(300, { dates: { US: [[3, '2026-11-20']] } });
  return w;
}
const api = (w) => w.paths('api.simkl.com').filter((p) => !p.startsWith('GET /movies/'));

test('the first sync reads the activities before any pull, then pulls every wanted list one after another', async () => {
  const w = ready();
  assert.strictEqual((await w.syncAll('manual')).text, 'done');
  assert.deepStrictEqual(api(w), [
    'GET /sync/activities',
    'GET /sync/all-items/shows/watching',
    'GET /sync/all-items/shows/plantowatch',
    'GET /sync/all-items/anime/watching',
    'GET /sync/all-items/anime/plantowatch',
    'GET /sync/all-items/movies/plantowatch',
  ]);
  assert.deepStrictEqual(w.pinIds(), ['an-200-7', 'mv-300-cinema', 'tv-100-1-1']);
});

test('every Simkl request carries the client id, app name, app version and user agent', async () => {
  const w = ready();
  await w.syncAll('manual');
  assert.ok(w.calls.length > 5);
  for (const c of w.calls) {
    assert.strictEqual(c.query.client_id, '0c2ba84016dd0ef96cb51b3dd5d77eaff1597be12102c28f089e08e3c846235e', c.path);
    assert.strictEqual(c.query['app-name'], 'simkl-timeline');
    assert.strictEqual(c.query['app-version'], '1.0.0');
    assert.strictEqual(c.headers['User-Agent'], 'simkl-timeline/1.0.0');
  }
});

test('the calendar files and movie lookups go out without the user\'s token; the watchlist calls carry it', async () => {
  const w = ready();
  await w.syncAll('manual');
  for (const c of w.calls) {
    const isWatchlist = c.path.startsWith('/sync/');
    assert.strictEqual(!!c.headers.Authorization, isWatchlist, c.host + c.path);
  }
});

// A dropped connection, not a 5xx: a 5xx is a busy Simkl, which the caller waits out.
function failFirstAnimePull(w) {
  w.hook = (call) => (call.path === '/sync/all-items/anime/watching' ? new TypeError('Network request failed') : undefined);
}

test('a pull that fails saves no snapshot; the retry carries on with the snapshot read before the first pull', async () => {
  const w = ready();
  failFirstAnimePull(w);
  const failed = await w.action('sync', { reason: 'manual' });
  assert.strictEqual(failed.error.code, 'UNKNOWN');
  assert.strictEqual(w.store('plugin.snapshot'), null);
  assert.strictEqual(w.store('sync_status').ok, false);
  assert.strictEqual(w.store('sync_status').state, 'offline');
  const firstRead = w.store('plugin.sync').lists.A.all;

  w.hook = null;
  w.resetCalls();
  assert.strictEqual((await w.syncAll('manual')).text, 'done');
  assert.ok(!w.paths('api.simkl.com').includes('GET /sync/activities'), 'the snapshot read before the pulls is still the one');
  assert.strictEqual(w.store('plugin.snapshot').all, firstRead);
  assert.deepStrictEqual(w.pinIds(), ['an-200-7', 'mv-300-cinema', 'tv-100-1-1']);
});

test('a failed first sync that is picked up much later starts again from the activities and pulls everything', async () => {
  const w = ready();
  failFirstAnimePull(w);
  await w.action('sync', { reason: 'manual' });
  w.hook = null;
  w.resetCalls();
  w.advance(11 * MIN);
  assert.strictEqual((await w.syncAll('manual')).text, 'done');
  const paths = w.paths('api.simkl.com');
  assert.strictEqual(paths[0], 'GET /sync/activities');
  assert.ok(paths.includes('GET /sync/all-items/shows/watching'));
  assert.ok(w.store('plugin.snapshot'));
});

test('the snapshot is the one read before the pulls, so a change made during them arrives with the next delta', async () => {
  const w = ready();
  w.setItem('anime', 500, 'Added mid-pull', 'watching');
  w.animeEpisode(500, null, 1, at(NOW + DAY));
  const first = JSON.parse(JSON.stringify(w.sim.activities));
  w.sim.rows.anime = w.sim.rows.anime.filter((r) => r.show.ids.simkl !== 500);
  // While the pulls run, the user adds a show on simkl.com; the shows list was already pulled.
  w.hook = (call) => {
    if (call.path === '/sync/all-items/anime/watching') w.setItem('shows', 101, 'Added mid-pull', 'watching');
  };
  w.tvEpisode(101, 1, 1, at(NOW + DAY));
  const read = JSON.parse(JSON.stringify(w.sim.activities));
  await w.syncAll('manual');
  assert.strictEqual(w.store('plugin.snapshot').all, read.all, 'saved snapshot predates the change');
  assert.ok(!w.pinIds().includes('tv-101-1-1'));

  w.hook = null;
  w.resetCalls();
  w.advance(2 * MIN);
  await w.syncAll('manual');
  const delta = w.callsTo('api.simkl.com').find((c) => c.path === '/sync/all-items');
  assert.strictEqual(delta.query.date_from, read.all);
  assert.ok(w.pinIds().includes('tv-101-1-1'));
  assert.ok(first);
});

test('later syncs fetch only the buckets that moved: nothing when nothing changed, a delta for a list change', async () => {
  const w = ready();
  await w.syncAll('manual');
  w.resetCalls();
  w.advance(2 * MIN);
  await w.syncAll('manual');
  assert.deepStrictEqual(api(w), ['GET /sync/activities']);

  w.setItem('shows', 101, 'New show', 'watching');
  w.tvEpisode(101, 1, 1, at(NOW + DAY));
  w.resetCalls();
  w.advance(2 * MIN);
  await w.syncAll('manual');
  assert.deepStrictEqual(api(w), ['GET /sync/activities', 'GET /sync/all-items']);
  assert.ok(w.pinIds().includes('tv-101-1-1'));
});

test('removals are found by diffing the ids, and only when removed_from_list moved', async () => {
  const w = ready();
  await w.syncAll('manual');
  w.removeItem('shows', 100);
  w.resetCalls();
  w.advance(2 * MIN);
  await w.syncAll('manual');
  const calls = w.callsTo('api.simkl.com').filter((c) => c.path.startsWith('/sync/'));
  assert.deepStrictEqual(calls.map((c) => c.path + (c.query.extended || '')), ['/sync/activities', '/sync/all-items' + 'simkl_ids_only']);
  assert.deepStrictEqual(w.pinIds(), ['an-200-7', 'mv-300-cinema']);
});

test('open waits 15 minutes before asking Simkl again, manual and settings one minute', async () => {
  const w = ready();
  await w.syncAll('manual');
  const asked = async (reason, wait) => {
    w.advance(wait);
    w.resetCalls();
    await w.syncAll(reason);
    return w.paths('api.simkl.com').includes('GET /sync/activities');
  };
  assert.strictEqual(await asked('open', 14 * MIN), false);
  assert.strictEqual(await asked('open', 2 * MIN), true, '16 minutes since the check');
  assert.strictEqual(await asked('manual', 30 * 1000), false);
  assert.strictEqual(await asked('manual', 31 * 1000), true, 'more than a minute');
});

test('scheduled never touches a watchlist endpoint or a token, only the calendar and movie lookups', async () => {
  const w = ready();
  await w.syncAll('manual');
  w.resetCalls();
  w.advance(5 * HOUR);
  // The access token has long expired: a scheduled run must not even look at it.
  w.signIn({ expiresAt: NOW - DAY });
  const r = await w.syncAll('scheduled');
  assert.strictEqual(r.text, 'done');
  const apiCalls = w.callsTo('api.simkl.com');
  assert.ok(apiCalls.every((c) => c.path.startsWith('/movies/')), JSON.stringify(apiCalls.map((c) => c.path)));
  assert.ok(w.calls.every((c) => !c.headers.Authorization));
  assert.ok(!w.secureReads.includes('tokens'));
  assert.ok(w.callsTo('data.simkl.in').length > 0);
  assert.deepStrictEqual(w.pinIds(), ['an-200-7', 'mv-300-cinema', 'tv-100-1-1']);
});

test('a scheduled run has no watchlist to work from until the user has opened the app once', async () => {
  const w = ready();
  const r = await w.syncAll('scheduled');
  assert.strictEqual(r.text, 'done');
  assert.deepStrictEqual(w.pinIds(), []);
  assert.deepStrictEqual(w.paths('api.simkl.com'), []);
});

test('switching on On Hold pulls just that list, even within the minute', async () => {
  const w = ready();
  w.setItem('shows', 400, 'Held', 'hold');
  w.tvEpisode(400, 1, 1, at(NOW + DAY));
  await w.syncAll('manual');
  assert.ok(!w.pinIds().includes('tv-400-1-1'));
  w.resetCalls();
  const saved = await w.config({ type: 'saveSettings', settings: { lists: { hold: true } } });
  assert.strictEqual(saved.ok, true);
  assert.deepStrictEqual(api(w), ['GET /sync/activities', 'GET /sync/all-items/shows/hold', 'GET /sync/all-items/anime/hold']);
  assert.ok(w.pinIds().includes('tv-400-1-1'));

  w.advance(2 * MIN);
  await w.config({ type: 'saveSettings', settings: { lists: { hold: false } } });
  assert.ok(!w.pinIds().includes('tv-400-1-1'));
});

// ---------------------------------------------------------------- calendar cache

test('the calendar is fetched once, revalidated with If-Modified-Since after a few hours, and kept on 304', async () => {
  const w = ready();
  await w.syncAll('manual');
  assert.deepStrictEqual(w.paths('data.simkl.in'), ['GET /calendar/v2/tv.json', 'GET /calendar/v2/anime.json']);
  assert.strictEqual(w.callsTo('data.simkl.in')[0].headers['If-Modified-Since'], undefined);

  w.resetCalls();
  w.advance(2 * HOUR);
  await w.syncAll('scheduled');
  assert.deepStrictEqual(w.callsTo('data.simkl.in'), [], 'two hours old is fresh');

  w.advance(2 * HOUR);
  await w.syncAll('scheduled');
  assert.deepStrictEqual(w.callsTo('data.simkl.in').map((c) => c.headers['If-Modified-Since']), [w.lastModified('tv'), w.lastModified('anime')]);
  assert.deepStrictEqual(w.pinIds(), ['an-200-7', 'mv-300-cinema', 'tv-100-1-1'], '304 keeps what was cached');
});

test('a title added to the lists forces a full download, not a revalidation that would miss it', async () => {
  const w = ready();
  await w.syncAll('manual');
  w.setItem('shows', 101, 'New show', 'watching');
  w.tvEpisode(101, 1, 1, at(NOW + DAY));
  w.resetCalls();
  w.advance(2 * MIN);
  await w.syncAll('manual');
  const tv = w.callsTo('data.simkl.in').filter((c) => c.path.endsWith('tv.json'));
  assert.strictEqual(tv.length, 1);
  assert.strictEqual(tv[0].headers['If-Modified-Since'], undefined);
  assert.ok(w.pinIds().includes('tv-101-1-1'));
});

test('a calendar file nobody needs is not downloaded', async () => {
  const w = createWorld();
  w.signIn();
  w.setSettings({});
  w.setItem('shows', 100, 'The Show', 'watching');
  w.tvEpisode(100, 1, 1, at(NOW + DAY));
  await w.syncAll('manual');
  assert.deepStrictEqual(w.paths('data.simkl.in'), ['GET /calendar/v2/tv.json']);
});

test('when the calendar stays unreachable the cached schedule stays on the timeline and the error is reported', async () => {
  const w = ready();
  await w.syncAll('manual');
  w.hook = (call) => (call.host === 'data.simkl.in' ? w.response(503, {}) : undefined);
  w.advance(4 * HOUR);
  const r = await w.syncAll('scheduled');
  assert.deepStrictEqual(w.waits, [1000, 2000, 4000], 'three waits, then the run carries on without it');
  assert.strictEqual(r.error.code, 'UNKNOWN');
  assert.match(r.error.message, /having problems/);
  assert.deepStrictEqual(w.pinIds(), ['an-200-7', 'mv-300-cinema', 'tv-100-1-1']);
  assert.strictEqual(w.store('sync_status').ok, false);
});

// ---------------------------------------------------------------- resumable sync

test('a long sync answers more, carries on where it stopped, and each request happens once', async () => {
  const w = ready();
  w.latency = 5000;
  const answers = [];
  for (let i = 0; i < 20; i++) {
    const r = await w.action('sync', { reason: 'manual' });
    answers.push(r.text);
    if (r.text === 'done') break;
  }
  assert.ok(answers.length >= 3, answers.join());
  assert.deepStrictEqual(answers.slice(0, -1).filter((a) => a !== 'more'), []);
  assert.strictEqual(answers[answers.length - 1], 'done');
  const counts = {};
  w.calls.forEach((c) => { counts[c.path] = (counts[c.path] || 0) + 1; });
  Object.keys(counts).forEach((p) => assert.strictEqual(counts[p], 1, p + ' was requested ' + counts[p] + ' times'));
  assert.deepStrictEqual(w.pinIds(), ['an-200-7', 'mv-300-cinema', 'tv-100-1-1']);
  assert.strictEqual(w.store('plugin.sync'), null);
  assert.strictEqual(w.store('sync_status').ok, true);
});

test('each invocation stops starting requests after about 12 seconds', async () => {
  const w = ready();
  w.latency = 5000;
  const start = w.clock.now;
  const r = await w.action('sync', { reason: 'manual' });
  assert.strictEqual(r.text, 'more');
  assert.ok(w.clock.now - start <= 15000, 'took ' + (w.clock.now - start));
  assert.strictEqual(w.calls.length, 3);
});

test('a run left unfinished for more than ten minutes starts over', async () => {
  const w = ready();
  w.latency = 5000;
  assert.strictEqual((await w.action('sync', { reason: 'manual' })).text, 'more');
  w.advance(11 * MIN);
  await w.action('sync', { reason: 'manual' });
  assert.strictEqual(w.paths('api.simkl.com').filter((p) => p === 'GET /sync/activities').length, 2);
});

test('a scheduled call in the middle of a manual run does not continue it into the watchlist', async () => {
  const w = ready();
  w.latency = 5000;
  assert.strictEqual((await w.action('sync', { reason: 'manual' })).text, 'more');
  w.resetCalls();
  w.advance(MIN);
  await w.syncAll('scheduled');
  assert.deepStrictEqual(w.paths('api.simkl.com').filter((p) => p.includes('/sync/')), []);
});

// ---------------------------------------------------------------- failures

test('a busy Simkl makes the caller wait and ask again, with Retry-After when it gives one', async () => {
  const w = ready();
  let limited = 1;
  w.hook = (call) => (call.path === '/sync/activities' && limited-- > 0 ? w.response(429, { error: 'rate_limit', code: 429 }) : undefined);
  const first = await w.action('sync', { reason: 'manual' });
  assert.deepStrictEqual(first, { ok: true, text: 'wait:1000' });
  assert.strictEqual(w.store('sync_status'), null, 'a wait is not a failure');
  w.advance(1000);
  assert.strictEqual((await w.syncAll('manual')).text, 'done');
  assert.strictEqual(w.paths('api.simkl.com').filter((p) => p === 'GET /sync/activities').length, 2);

  const told = ready();
  let busy = 1;
  told.hook = (call) => (call.path === '/sync/activities' && busy-- > 0 ? told.response(503, {}, { 'retry-after': '7' }) : undefined);
  assert.strictEqual((await told.syncAll('manual')).text, 'done');
  assert.deepStrictEqual(told.waits, [7000]);
});

test('a Simkl that stays busy is reported after three waits, and the run keeps its place', async () => {
  const w = ready();
  w.hook = (call) => (call.path === '/sync/activities' ? w.response(503, {}) : undefined);
  const r = await w.syncAll('manual');
  assert.deepStrictEqual(w.waits, [1000, 2000, 4000]);
  assert.strictEqual(r.error.code, 'UNKNOWN');
  assert.match(r.error.message, /having problems/);
  assert.strictEqual(w.paths('api.simkl.com').filter((p) => p === 'GET /sync/activities').length, 4);
  assert.strictEqual(w.store('plugin.snapshot'), null);

  w.hook = null;
  w.resetCalls();
  assert.strictEqual((await w.syncAll('manual')).text, 'done');
  assert.deepStrictEqual(w.waits, [], 'the count starts again');
});

test('a daily quota 429 is reported at once, without waiting', async () => {
  const w = ready();
  w.hook = (call) => (call.path === '/sync/activities' ? w.response(429, { error: 'user_limit_exceeded', code: 429 }, { 'retry-after': '40000' }) : undefined);
  const r = await w.syncAll('manual');
  assert.strictEqual(r.error.code, 'UNKNOWN');
  assert.match(r.error.message, /daily limit/);
  assert.strictEqual(w.calls.length, 1);
  assert.deepStrictEqual(w.waits, []);
});

test('a request that fails in the engine for another reason keeps its own message', async () => {
  const w = ready();
  w.hook = () => new RangeError('Invalid header value');
  const r = await w.action('sync', { reason: 'manual' });
  assert.strictEqual(r.error.code, 'UNKNOWN');
  assert.doesNotMatch(r.error.message, /Can't reach/);
  assert.match(r.error.message, /Invalid header value/);
});

test('being offline is reported as offline, naming the host', async () => {
  const w = ready();
  w.hook = () => new TypeError('fetch failed');
  const r = await w.action('sync', { reason: 'manual' });
  assert.strictEqual(r.error.code, 'UNKNOWN');
  assert.match(r.error.message, /Can't reach api\.simkl\.com/);
  assert.strictEqual(w.store('sync_status').state, 'offline');
});

test('a permission that is not granted is named without making a request', async () => {
  let w = ready();
  w.permissions['Internet/api.simkl.com'] = 'denied';
  let r = await w.action('sync', { reason: 'manual' });
  assert.strictEqual(r.error.code, 'PERMISSION_DENIED');
  assert.match(r.error.message, /api\.simkl\.com/);
  assert.strictEqual(w.store('sync_status').state, 'permission');
  assert.strictEqual(w.calls.length, 0);

  w = ready();
  w.permissions.Timeline = 'prompt';
  r = await w.action('sync', { reason: 'scheduled' });
  assert.strictEqual(r.error.code, 'PERMISSION_DENIED');
  assert.match(r.error.message, /timeline/i);

  w = ready();
  w.permissions['Internet/data.simkl.in'] = 'denied';
  r = await w.action('sync', { reason: 'open' });
  assert.match(r.error.message, /data\.simkl\.in/);
});

test('without Pebble.permissions, a blocked fetch is still named', async () => {
  const w = ready();
  w.permissionApi = false;
  w.hook = (call) => (call.host === 'data.simkl.in' ? Object.assign(new Error('fetch not allowed'), { name: 'NotAllowedError' }) : undefined);
  const r = await w.action('sync', { reason: 'manual' });
  assert.strictEqual(r.error.code, 'PERMISSION_DENIED');
  assert.match(r.error.message, /data\.simkl\.in/);
});

test('a Pebble app without timeline pins is told to update, and no request is made', async () => {
  const w = ready();
  w.pinApi = false;
  const r = await w.action('sync', { reason: 'manual' });
  assert.strictEqual(r.error.code, 'PLUGIN_UNAVAILABLE');
  assert.match(r.error.message, /1\.18/);
  assert.strictEqual(w.store('sync_status').state, 'needs_update');
  assert.strictEqual(w.calls.length, 0);
});

test('signed out: the sync asks for a sign-in and says so in the status', async () => {
  const w = createWorld();
  w.setSettings({});
  const r = await w.action('sync', { reason: 'open' });
  assert.strictEqual(r.error.code, 'AUTH_REQUIRED');
  assert.strictEqual(w.store('sync_status').state, 'signed_out');
  assert.strictEqual(w.calls.length, 0);
});

test('an unknown sync reason is rejected', async () => {
  const w = ready();
  const r = await w.action('sync', { reason: 'whenever' });
  assert.strictEqual(r.error.code, 'INVALID_ARGS');
});

// ---------------------------------------------------------------- one run at a time

const lockOf = (w, until, owner = 'someone-else') => w.setStore('plugin.syncLock', { owner, until });

test('a sync that starts while another holds the lock asks to be called again and does nothing', async () => {
  const w = ready();
  lockOf(w, w.clock.now + 20000);
  const r = await w.action('sync', { reason: 'manual' });
  assert.deepStrictEqual(r, { ok: true, text: 'wait:1000' });
  assert.strictEqual(w.calls.length, 0);
  assert.deepStrictEqual(w.phone.ops, []);
  assert.strictEqual(w.store('plugin.sync'), null);
});

test('a lock nobody renewed for 30 seconds is taken over, and released when the run ends', async () => {
  const w = ready();
  lockOf(w, w.clock.now - 1);
  assert.strictEqual((await w.syncAll('manual')).text, 'done');
  assert.ok(w.calls.length > 0);
  assert.strictEqual(w.store('plugin.syncLock'), null);
});

test('a run renews its lock as it goes, so a slow one is not taken over', async () => {
  const w = ready();
  w.latency = 5000;
  let heldAtRequests = [];
  w.hook = () => { heldAtRequests.push(w.store('plugin.syncLock')); };
  await w.action('sync', { reason: 'manual' });
  assert.ok(heldAtRequests.length >= 3);
  heldAtRequests.forEach((l, i) => assert.ok(l && l.until > w.calls[i].at, 'lock live at request ' + i));
  assert.strictEqual(w.store('plugin.syncLock'), null, 'released when the invocation answers more');
});

test('the config page is told to wait while a sync runs, then runs its own', async () => {
  const w = ready();
  lockOf(w, w.clock.now + 5000);
  let r = await w.config({ type: 'syncNow' });
  assert.strictEqual(r.retryAfterMs, 1000);
  assert.strictEqual(w.calls.length, 0);
  let rounds = 0;
  while (r.retryAfterMs && rounds < 10) {
    rounds++;
    w.advance(r.retryAfterMs);
    r = await w.config({ type: 'syncNow', resume: true });
  }
  assert.strictEqual(r.ok, true);
  assert.ok(rounds >= 5, 'rounds ' + rounds);
  assert.deepStrictEqual(w.pinIds(), ['an-200-7', 'mv-300-cinema', 'tv-100-1-1']);
});

test('sign-out during a sync is refused with a wait, and nothing is cleared', async () => {
  const w = ready();
  await w.syncAll('manual');
  lockOf(w, w.clock.now + 10 * 60 * 1000);
  w.resetCalls();
  const r = await w.config({ type: 'signout' });
  assert.match(r.error, /sync is running/);
  assert.strictEqual(r.retryAfterMs, 1000);
  assert.strictEqual(w.calls.length, 0);
  assert.ok(w.secure.has('tokens'));
  assert.strictEqual(w.pinIds().length, 3);
});

test('a pin deleted by mark_watched while a sync is inserting stays deleted, so its id is not reused', async () => {
  const w = ready();
  w.tvEpisode(100, 1, 2, at(NOW + 2 * DAY));
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), ['an-200-7', 'mv-300-cinema', 'tv-100-1-1', 'tv-100-1-2']);

  // Episode 3 appears; while the sync inserts it, the user marks episode 1 watched on the watch.
  w.tvEpisode(100, 1, 3, at(NOW + 3 * DAY));
  w.advance(4 * HOUR);
  let once = true;
  w.onInsert = async (pin) => {
    if (!once || pin.id !== 'tv-100-1-3') return;
    once = false;
    assert.deepStrictEqual(await w.action('mark_watched', { kind: 'tv', simkl: 100, season: 1, episode: 1 }), { ok: true, text: 'Marked watched' });
  };
  await w.syncAll('scheduled');
  assert.strictEqual(w.store('pins')['tv-100-1-1'].deleted, true);
  assert.ok(!w.pinIds().includes('tv-100-1-1'));
  assert.ok(w.pinIds().includes('tv-100-1-3'));
});
