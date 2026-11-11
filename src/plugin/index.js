// Simkl Timeline engine.
//
// The Pebble app starts this script fresh for every request, so nothing lives in variables:
// everything that must survive is in Pebble.secureStorage, private to this plugin.
//
// Not localStorage: it is shared with PKJS, and on Android PKJS works on a copy of it that it
// writes back when it stops, erasing whatever the plugin stored in the meantime. PKJS gets what
// the watch shows from the watch_data action instead.
//
// The plugin engine has no timers: the Android app blocks setTimeout and iOS has none. So the
// plugin never waits. A sync answers 'wait:<ms>' and the config page gets retryAfterMs, and the
// caller (PKJS or the page) waits before asking again.
//
// Pebble.secureStorage:
//   tokens            { access, refresh, expiresAt, scope }
//   device_code       of the sign-in in progress
//   settings, account, signin, sync_status, upcoming   what the settings page and the watch show
//   pins              pin id -> { key, time (ms), hash, deleted? }
//   plugin.lists      { items: { "tv:123": { kind, simkl, status, title, year, slug } }, pulled: { "tv:watching": true } }
//   plugin.snapshot   the /sync/activities answer the lists are current as of
//   plugin.listsAt    ms of the last completed watchlist check
//   plugin.cal.tv / plugin.cal.anime   calendar entries for the user's titles + the file's Last-Modified
//   plugin.movies     movie id -> cached /movies/{id} facts and release dates
//   plugin.watched    pin key -> time (ms) of items the user marked watched, so they are not pinned again
//   plugin.sync       progress of the sync in flight
//   plugin.pollNext   ms before which signin_poll does not call Simkl
//   plugin.refreshLock  ms until which one invocation owns the token refresh
//   plugin.syncLock   { owner, until } of the sync that runs now

var CLIENT_ID = '0c2ba84016dd0ef96cb51b3dd5d77eaff1597be12102c28f089e08e3c846235e';
var APP_NAME = 'simkl-timeline';
var APP_VERSION = '1.1.0';
var USER_AGENT = APP_NAME + '/' + APP_VERSION;
var API_HOST = 'api.simkl.com';
var CDN_HOST = 'data.simkl.in';
var CALENDAR_PATH = '/calendar/v2/';

var MINUTE = 60 * 1000;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;
var STEP_BUDGET_MS = 12000; // stop starting work after this; the host kills an action at 20 s
var FULL_STEP_BUDGET_MS = 270000; // config page messages get 5 minutes
var LOCK_TTL_MS = 30000; // a killed run frees the lock this long after its last renewal
var LOCK_RETRY_MS = 1000; // how long a caller waits before asking again while a lock is held
var STALE_RUN_MS = 10 * MINUTE;
var CALENDAR_MAX_AGE_MS = 3 * HOUR; // the CDN regenerates every 6 hours
var PIN_KEEP_MS = 4 * DAY;
var PIN_PAST_WINDOW_MS = 2 * DAY;
var UPCOMING_PAST_MS = 3 * HOUR;
var UPCOMING_MAX = 16;
var TOKEN_REFRESH_BEFORE_MS = DAY;
var MOVIE_FRESH_AHEAD_MS = DAY;
var MOVIE_FRESH_MS = 7 * DAY;
var MOVIE_PARALLEL = 3;
var LISTS_RECHECK_MS = { open: 15 * MINUTE, manual: MINUTE, settings: MINUTE };
var BACKOFF_MS = [1000, 2000, 4000]; // waits before asking a busy Simkl again, when it gives no Retry-After

var STATUS_KEYS = ['watching', 'plantowatch', 'hold'];
var LIST_BUCKETS = ['watching', 'plantowatch', 'hold', 'completed', 'dropped', 'notinteresting'];
var KINDS = ['tv', 'anime', 'movie'];
var KIND_ENDPOINT = { tv: 'shows', anime: 'anime', movie: 'movies' };
var KIND_ACTIVITY = { tv: 'tv_shows', anime: 'anime', movie: 'movies' };
var KIND_SITE = { tv: 'tv', anime: 'anime', movie: 'movies' };
var REMINDER_CHOICES = [-1, 0, 5, 15, 30, 60];
var DAYS_AHEAD_CHOICES = [7, 14, 30];
var RELEASE_CHOICES = ['cinema', 'digital', 'both'];
var FINALE_TEXT = { 1: 'Mid-season finale', 2: 'Season finale', 3: 'Series finale' };

var PERMISSION_SPEC = {
  simkl: { name: 'Internet/api.simkl.com', domain: API_HOST },
  cdn: { name: 'Internet/data.simkl.in', domain: CDN_HOST },
  timeline: { name: 'Timeline', domain: null },
};
var UPDATE_MESSAGE = 'Timeline pins need the Pebble app version 1.18 or later. Update the Pebble app.';

// ---------------------------------------------------------------- errors

var DEFAULT_STATE = { AUTH_REQUIRED: 'signed_out', PERMISSION_DENIED: 'permission', PLUGIN_UNAVAILABLE: 'needs_update', UNKNOWN: 'error', INVALID_ARGS: 'error' };

function PluginError(code, message, state) {
  this.name = 'PluginError';
  this.code = code;
  this.message = message;
  this.state = state || DEFAULT_STATE[code] || 'error';
}
PluginError.prototype = Object.create(Error.prototype);

function isPluginError(e) {
  return !!e && e.name === 'PluginError';
}

// Whatever the user must fix or wait for before another request can work.
function isFatal(e) {
  return isPluginError(e) && (e.code === 'AUTH_REQUIRED' || e.code === 'PERMISSION_DENIED' || e.code === 'PLUGIN_UNAVAILABLE');
}

function asPluginError(e) {
  return isPluginError(e) ? e : new PluginError('UNKNOWN', 'Something went wrong: ' + (e && e.message ? e.message : String(e)) + '.');
}

// Simkl or another run is busy. Nothing failed for good: the caller asks again after
// retryAfterMs (null: the next BACKOFF_MS step). `counts`: whether it uses up a backoff try.
function busyError(message, retryAfterMs, counts) {
  var e = new PluginError('UNKNOWN', message, 'busy');
  e.retryAfterMs = retryAfterMs;
  e.counts = counts;
  return e;
}

function isBusy(e) {
  return isPluginError(e) && e.state === 'busy';
}

function waitAnswer(ms) {
  return 'wait:' + Math.round(ms);
}

function waitOf(answer) {
  var m = /^wait:(\d+)$/.exec(answer || '');
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- storage

async function load(key, fallback) {
  var raw = await Pebble.secureStorage.getItem(key);
  if (raw === null || raw === undefined) return fallback;
  try {
    var value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch (_e) {
    return fallback;
  }
}

async function save(key, value) {
  await Pebble.secureStorage.setItem(key, JSON.stringify(value));
}

async function drop(key) {
  await Pebble.secureStorage.removeItem(key);
}

async function readTokens() {
  var raw = await Pebble.secureStorage.getItem('tokens');
  if (!raw) return null;
  try {
    var tokens = JSON.parse(raw);
    return tokens && tokens.access ? tokens : null;
  } catch (_e) {
    return null;
  }
}

async function writeTokens(tokens) {
  await Pebble.secureStorage.setItem('tokens', JSON.stringify(tokens));
}

// ---------------------------------------------------------------- settings

function defaultSettings() {
  return {
    types: { tv: true, anime: true, movies: true },
    lists: { watching: true, plantowatch: true, hold: false },
    movieRelease: 'cinema',
    country: '',
    movieTime: '09:00',
    daysAhead: 14,
    reminder: -1,
    syncTimes: [360, -1],
  };
}

async function getSettings() {
  var stored = await load('settings', null);
  return stored ? validateSettings(stored, defaultSettings()).value || defaultSettings() : defaultSettings();
}

// Fills gaps from `base`, so a page that sends part of the settings keeps the rest.
function validateSettings(input, base) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Settings must be an object.' };
  var out = {
    types: { tv: base.types.tv, anime: base.types.anime, movies: base.types.movies },
    lists: { watching: base.lists.watching, plantowatch: base.lists.plantowatch, hold: base.lists.hold },
    movieRelease: base.movieRelease,
    country: base.country,
    movieTime: base.movieTime,
    daysAhead: base.daysAhead,
    reminder: base.reminder,
    syncTimes: base.syncTimes.slice(),
  };
  var group;
  var key;
  var names = { types: ['tv', 'anime', 'movies'], lists: STATUS_KEYS };
  for (group in names) {
    if (input[group] === undefined) continue;
    if (!input[group] || typeof input[group] !== 'object') return { error: 'Settings ' + group + ' must be an object.' };
    for (var i = 0; i < names[group].length; i++) {
      key = names[group][i];
      if (input[group][key] === undefined) continue;
      if (typeof input[group][key] !== 'boolean') return { error: 'Settings ' + group + '.' + key + ' must be on or off.' };
      out[group][key] = input[group][key];
    }
  }
  if (input.movieRelease !== undefined) {
    if (RELEASE_CHOICES.indexOf(input.movieRelease) < 0) return { error: 'Movie releases must be cinema, digital or both.' };
    out.movieRelease = input.movieRelease;
  }
  if (input.country !== undefined) {
    if (typeof input.country !== 'string' || !/^([A-Za-z]{2})?$/.test(input.country)) return { error: 'The country must be a two letter code, or empty for automatic.' };
    out.country = input.country.toUpperCase();
  }
  if (input.movieTime !== undefined) {
    if (typeof input.movieTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.movieTime)) return { error: 'The release time must look like 09:00.' };
    out.movieTime = input.movieTime;
  }
  if (input.daysAhead !== undefined) {
    if (DAYS_AHEAD_CHOICES.indexOf(input.daysAhead) < 0) return { error: 'Days ahead must be 7, 14 or 30.' };
    out.daysAhead = input.daysAhead;
  }
  if (input.reminder !== undefined) {
    if (REMINDER_CHOICES.indexOf(input.reminder) < 0) return { error: 'The reminder must be off, or 0, 5, 15, 30 or 60 minutes.' };
    out.reminder = input.reminder;
  }
  if (input.syncTimes !== undefined) {
    var times = input.syncTimes;
    var valid = Array.isArray(times) && times.length === 2 && times.every(function (t) {
      return t === -1 || (typeof t === 'number' && t % 1 === 0 && t >= 0 && t < 1440);
    });
    if (!valid) return { error: 'Sync times must be two minutes of the day (0 to 1439), or -1 for off.' };
    out.syncTimes = times.slice();
  }
  return { value: out };
}

function sliceWanted(settings, kind, status) {
  if (kind === 'movie') return settings.types.movies && status === 'plantowatch';
  return settings.types[kind] && STATUS_KEYS.indexOf(status) >= 0 && !!settings.lists[status];
}

function wantedSlices(settings) {
  var out = [];
  KINDS.forEach(function (kind) {
    STATUS_KEYS.forEach(function (status) {
      if (sliceWanted(settings, kind, status)) out.push({ kind: kind, status: status });
    });
  });
  return out;
}

function typeEnabled(settings, kind) {
  return kind === 'movie' ? settings.types.movies : settings.types[kind];
}

// ---------------------------------------------------------------- permissions and platform

async function permissionState(spec) {
  if (!Pebble.permissions || typeof Pebble.permissions.query !== 'function') return 'unknown';
  try {
    return await Pebble.permissions.query(spec.name);
  } catch (_e) {
    return 'unknown';
  }
}

async function permissionStates() {
  return {
    simkl: await permissionState(PERMISSION_SPEC.simkl),
    cdn: await permissionState(PERMISSION_SPEC.cdn),
    timeline: await permissionState(PERMISSION_SPEC.timeline),
  };
}

function permissionError(which) {
  var spec = PERMISSION_SPEC[which];
  if (spec.domain) {
    return new PluginError('PERMISSION_DENIED', 'Simkl Timeline is not allowed to connect to ' + spec.domain + '. Turn on "Connect to ' + spec.domain + '" in the app\'s permissions in the Pebble app.');
  }
  return new PluginError('PERMISSION_DENIED', 'Simkl Timeline is not allowed to use the timeline. Turn on "Timeline" in the app\'s permissions in the Pebble app.');
}

// With Pebble.permissions a missing grant is known for sure, with no request made.
async function requirePermissions(which) {
  for (var i = 0; i < which.length; i++) {
    var state = await permissionState(PERMISSION_SPEC[which[i]]);
    if (state === 'prompt' || state === 'denied') throw permissionError(which[i]);
  }
}

function hasPinApi() {
  return typeof Pebble.insertTimelinePin === 'function' && typeof Pebble.deleteTimelinePin === 'function';
}

function requirePinApi() {
  if (!hasPinApi()) throw new PluginError('PLUGIN_UNAVAILABLE', UPDATE_MESSAGE, 'needs_update');
}

// ---------------------------------------------------------------- HTTP

function encodeQuery(query) {
  return Object.keys(query).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]);
  }).join('&');
}

function buildUrl(host, path, query) {
  var q = {};
  var k;
  for (k in query || {}) q[k] = query[k];
  q.client_id = CLIENT_ID;
  q['app-name'] = APP_NAME;
  q['app-version'] = APP_VERSION;
  return 'https://' + host + path + '?' + encodeQuery(q);
}

// The host's fetch rejects with a TypeError when the network fails or times out. Anything else
// is not a connection problem, so it keeps its own message.
function transportError(e, host) {
  if (e && e.name === 'NotAllowedError') {
    return new PluginError('PERMISSION_DENIED', 'Simkl Timeline is not allowed to connect to ' + host + '. Turn on "Connect to ' + host + '" in the app\'s permissions in the Pebble app.');
  }
  if (e && e.name === 'TypeError') {
    if (/^fetch timeout/.test(e.message || '')) return new PluginError('UNKNOWN', host + ' took too long to answer. Try again.', 'offline');
    return new PluginError('UNKNOWN', 'Can\'t reach ' + host + '. Check the internet connection.', 'offline');
  }
  return asPluginError(e);
}

// Retry-After in seconds, as a wait in ms between 1 s and 1 min; null without one.
function retryAfterMs(r) {
  var seconds = Number(header(r, 'retry-after'));
  if (!(seconds > 0)) return null;
  return Math.min(Math.max(seconds * 1000, 1000), MINUTE);
}

async function readResponse(res) {
  var text = '';
  try {
    text = await res.text();
  } catch (_e) {
    text = '';
  }
  var json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_e) {
      json = null;
    }
  }
  return { status: res.status, text: text, json: json, headers: res.headers };
}

function header(r, name) {
  return r.headers && typeof r.headers.get === 'function' ? r.headers.get(name) : null;
}

// What a status the caller did not expect means to the user.
function failure(r, host) {
  var id = r.json && (r.json.error || r.json.message);
  if (r.status === 429) {
    return new PluginError('UNKNOWN', 'Simkl asked us to slow down. Try again in a few minutes.');
  }
  if (r.status >= 500) {
    return new PluginError('UNKNOWN', 'Simkl is having problems (HTTP ' + r.status + '). Try again later.');
  }
  return new PluginError('UNKNOWN', 'Simkl answered HTTP ' + r.status + (id ? ' (' + id + ')' : '') + ' from ' + host + '.');
}

// One request. A per-second 429 or a 5xx is a busy error for the caller to wait out.
async function http(cx, o) {
  var url = buildUrl(o.host, o.path, o.query);
  var init = { method: o.method || 'GET', headers: { 'User-Agent': USER_AGENT } };
  var k;
  for (k in o.headers || {}) init.headers[k] = o.headers[k];
  if (o.form) {
    var form = { client_id: CLIENT_ID };
    for (k in o.form) form[k] = o.form[k];
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encodeQuery(form);
  } else if (o.json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(o.json);
  }
  await renewLock(cx);
  var r;
  try {
    // No timeout of our own: the host times requests out, and the action itself at 20 s.
    r = await readResponse(await fetch(url, init));
  } catch (e) {
    throw transportError(e, o.host);
  }
  if (r.status === 429 && !(r.json && r.json.error === 'rate_limit')) {
    // Only the per-second 429 clears quickly; the daily ones need hours.
    throw new PluginError('UNKNOWN', 'Simkl\'s daily limit for this account is used up. Try again later.');
  }
  if (r.status === 429 || r.status >= 500) throw busyError(failure(r, o.host).message, retryAfterMs(r), true);
  return r;
}

// An authorized call to api.simkl.com; one 401 recovery, never a refresh loop.
async function simkl(cx, method, path, o) {
  o = o || {};
  var accept = o.accept || [200, 201];
  var tokens = await currentTokens(cx);
  var send = function (access) {
    return http(cx, { host: API_HOST, path: path, method: method, query: o.query, json: o.json, headers: { Authorization: 'Bearer ' + access } });
  };
  var r = await send(tokens.access);
  if (r.status === 401) {
    // Refreshing first re-reads the stored token: if another invocation already refreshed, that one is used.
    var recovered = await refreshTokens(cx, tokens.access);
    r = await send(recovered.access);
    if (r.status === 401) {
      await clearCredentials();
      throw new PluginError('AUTH_REQUIRED', 'Simkl no longer accepts the sign-in. Sign in again.');
    }
  }
  if (accept.indexOf(r.status) < 0) throw failure(r, API_HOST);
  return r;
}

// ---------------------------------------------------------------- tokens

function tokensFrom(json, previous) {
  var expiresIn = Number(json.expires_in);
  return {
    access: json.access_token,
    refresh: json.refresh_token || (previous && previous.refresh) || '',
    expiresAt: Date.now() + (expiresIn > 0 ? expiresIn * 1000 : 7 * DAY),
    scope: typeof json.scope === 'string' ? json.scope : (previous && previous.scope) || '',
  };
}

async function currentTokens(cx) {
  var tokens = await readTokens();
  if (!tokens) throw new PluginError('AUTH_REQUIRED', 'Sign in to Simkl to see upcoming episodes.');
  if (tokens.expiresAt - Date.now() < TOKEN_REFRESH_BEFORE_MS) {
    try {
      return await refreshTokens(cx, tokens.access);
    } catch (e) {
      // A refresh that failed for a passing reason is not fatal while this token still works.
      if (isFatal(e) || tokens.expiresAt <= Date.now()) throw e;
    }
  }
  return tokens;
}

// One owner at a time: while another invocation refreshes, this one asks again later for its token.
async function refreshTokens(cx, staleAccess) {
  var before = await readTokens();
  if (!before) throw new PluginError('AUTH_REQUIRED', 'Sign in to Simkl to see upcoming episodes.');
  if (before.access !== staleAccess) return before;
  if (await load('plugin.refreshLock', 0) > Date.now()) {
    throw busyError('Simkl Timeline is renewing its Simkl sign-in. Try again in a moment.', LOCK_RETRY_MS, false);
  }
  await save('plugin.refreshLock', Date.now() + 20000);
  try {
    var r = await http(cx, { host: API_HOST, path: '/oauth2/token', method: 'POST', form: { grant_type: 'refresh_token', refresh_token: before.refresh } });
    if (r.status === 200 && r.json && r.json.access_token) {
      var fresh = tokensFrom(r.json, before);
      await writeTokens(fresh);
      return fresh;
    }
    var code = r.json && r.json.error;
    if (r.status === 400 || r.status === 401) {
      if (code === 'invalid_grant' || code === 'invalid_client' || code === 'invalid_token') {
        await clearCredentials();
        throw new PluginError('AUTH_REQUIRED', 'Simkl ended this sign-in. Sign in again.');
      }
    }
    throw failure(r, API_HOST);
  } finally {
    await drop('plugin.refreshLock');
  }
}

// ---------------------------------------------------------------- account state

async function liveRecords() {
  var pins = await load('pins', {});
  return Object.keys(pins).filter(function (id) { return !pins[id].deleted; });
}

async function writeStatus(ok, state, message, extra) {
  var previous = await load('sync_status', null);
  var status = {
    at: Date.now(),
    ok: ok,
    state: state,
    message: message,
    lastOkAt: ok ? Date.now() : (previous && previous.lastOkAt) || 0,
    listsCheckedAt: await load('plugin.listsAt', 0),
    pinCount: (await liveRecords()).length,
  };
  if (extra) {
    for (var k in extra) status[k] = extra[k];
  }
  await save('sync_status', status);
  return status;
}

// What belongs to one Simkl account. Pin records stay: their deleted ids must not be reused.
async function wipeUserData() {
  var keys = ['account', 'signin', 'upcoming', 'plugin.lists', 'plugin.snapshot', 'plugin.listsAt', 'plugin.sync', 'plugin.pollNext',
    'plugin.cal.tv', 'plugin.cal.anime', 'plugin.watched'];
  for (var i = 0; i < keys.length; i++) await drop(keys[i]);
}

async function clearCredentials() {
  await Pebble.secureStorage.removeItem('tokens');
  await Pebble.secureStorage.removeItem('device_code');
  await wipeUserData();
  await writeStatus(false, 'signed_out', 'Sign in to Simkl to see upcoming episodes.', { lastOkAt: 0 });
}

// Sets `deleted` on the stored records, reading them again first so a concurrent writer's changes survive.
async function markDeleted(ids) {
  var pins = await load('pins', {});
  ids.forEach(function (id) { if (pins[id]) pins[id].deleted = true; });
  await save('pins', pins);
}

async function deleteAllPins() {
  var done = [];
  var failed = null;
  var ids = await liveRecords();
  for (var i = 0; i < ids.length; i++) {
    try {
      if (hasPinApi()) await Pebble.deleteTimelinePin(ids[i]);
      done.push(ids[i]);
    } catch (e) {
      failed = failed || e;
    }
  }
  await markDeleted(done);
  return failed;
}

// ---------------------------------------------------------------- sign in

async function startSignin(cx) {
  await requirePermissions(['simkl']);
  var live = await load('signin', null);
  var code = await Pebble.secureStorage.getItem('device_code');
  if (live && code && live.expiresAt - Date.now() > MINUTE) return live;
  var r = await http(cx, { host: API_HOST, path: '/oauth2/device', method: 'POST', form: { scope: 'media:read media:write' } });
  var j = r.json;
  if (r.status !== 200 || !j || !j.device_code || !j.user_code) throw failure(r, API_HOST);
  var interval = Number(j.interval) > 0 ? Number(j.interval) : 5;
  var signin = {
    userCode: j.user_code,
    uri: j.verification_uri,
    uriComplete: j.verification_uri_complete || j.verification_uri + '?user_code=' + j.user_code,
    expiresAt: Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) : 900) * 1000,
    interval: interval,
  };
  await Pebble.secureStorage.setItem('device_code', j.device_code);
  await save('signin', signin);
  await save('plugin.pollNext', Date.now() + interval * 1000);
  return signin;
}

async function endSignin() {
  await Pebble.secureStorage.removeItem('device_code');
  await drop('signin');
  await drop('plugin.pollNext');
}

function hasScope(scope, wanted) {
  return typeof scope === 'string' && scope.split(/[\s,+]+/).indexOf(wanted) >= 0;
}

// 'pending' | 'approved' | 'expired'; throws for everything else.
async function pollSignin(cx) {
  await requirePermissions(['simkl']);
  var signin = await load('signin', null);
  var deviceCode = await Pebble.secureStorage.getItem('device_code');
  if (!signin || !deviceCode) return 'expired';
  // Simkl never says no, so our own deadline is the only end for a user who declined.
  if (Date.now() >= signin.expiresAt) {
    await endSignin();
    return 'expired';
  }
  if (Date.now() < await load('plugin.pollNext', 0)) return 'pending';
  var r;
  try {
    r = await http(cx, { host: API_HOST, path: '/oauth2/token', method: 'POST', form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode } });
  } catch (e) {
    // A busy Simkl is asked again at the next poll anyway.
    if (isBusy(e)) return 'pending';
    throw e;
  } finally {
    await save('plugin.pollNext', Date.now() + signin.interval * 1000);
  }
  var error = r.json && r.json.error;
  if (r.status === 200 && r.json && r.json.access_token) return finishSignin(cx, r.json);
  if (error === 'authorization_pending') return 'pending';
  if (error === 'slow_down') {
    // The rejected attempt re-armed Simkl's timer, so the wait has to be real.
    signin.interval += 5;
    await save('signin', signin);
    await save('plugin.pollNext', Date.now() + signin.interval * 1000);
    return 'pending';
  }
  if (error === 'expired_token') {
    await endSignin();
    return 'expired';
  }
  if (error === 'invalid_client') {
    await endSignin();
    throw new PluginError('UNKNOWN', 'Simkl does not recognise this app (invalid_client). Update Simkl Timeline.');
  }
  throw failure(r, API_HOST);
}

async function revokeToken(cx, token) {
  try {
    await http(cx, { host: API_HOST, path: '/oauth2/revoke', method: 'POST', form: { token: token } });
    return true;
  } catch (_e) {
    return false;
  }
}

async function finishSignin(cx, json) {
  var tokens = tokensFrom(json, null);
  // An unrecognised scope is quietly downgraded to read-only, which would only show on the first write.
  if (!hasScope(tokens.scope, 'media:write')) {
    await revokeToken(cx, tokens.refresh || tokens.access);
    await endSignin();
    throw new PluginError('UNKNOWN', 'Simkl did not allow marking episodes as watched. Start the sign-in again.');
  }
  var name;
  try {
    var r = await http(cx, { host: API_HOST, path: '/users/settings', method: 'POST', headers: { Authorization: 'Bearer ' + tokens.access } });
    name = r.status === 200 && r.json && r.json.user && r.json.user.name;
    if (!name) throw failure(r, API_HOST);
  } catch (e) {
    await revokeToken(cx, tokens.refresh || tokens.access);
    await endSignin();
    throw isPluginError(e) ? new PluginError(e.code, 'Signed in, but could not read your Simkl name. ' + e.message + ' Start the sign-in again.', e.state) : e;
  }
  var previous = await load('account', null);
  if (previous && previous.name !== name) {
    await deleteAllPins();
    await wipeUserData();
  }
  await writeTokens(tokens);
  await endSignin();
  await save('account', { name: name });
  return 'approved';
}

async function signOut(cx) {
  var tokens = await readTokens();
  var revoked = true;
  if (tokens) revoked = await revokeToken(cx, tokens.refresh || tokens.access);
  var failed = await deleteAllPins();
  await clearCredentials();
  await drop('plugin.movies');
  await drop('plugin.refreshLock');
  return { ok: !failed, revoked: revoked, error: failed ? 'Some timeline pins could not be removed.' : undefined };
}

// ---------------------------------------------------------------- watchlist

async function loadLists() {
  var lists = await load('plugin.lists', null);
  return lists && lists.items ? lists : { items: {}, pulled: {} };
}

function rowItem(kind, row) {
  var media = row.show || row.movie || row.anime;
  if (!media || !media.ids || !media.ids.simkl) return null;
  return {
    kind: kind,
    simkl: media.ids.simkl,
    status: row.status,
    title: media.title || '',
    year: typeof media.year === 'number' ? media.year : null,
    slug: media.ids.slug || '',
  };
}

function itemKey(kind, simkl) {
  return kind + ':' + simkl;
}

function mergeRows(lists, settings, kind, rows) {
  (rows || []).forEach(function (row) {
    var item = rowItem(kind, row);
    if (!item) return;
    if (sliceWanted(settings, kind, item.status)) lists.items[itemKey(kind, item.simkl)] = item;
    else delete lists.items[itemKey(kind, item.simkl)];
  });
}

function statusMoved(now, before, kind) {
  var a = (now && now[KIND_ACTIVITY[kind]]) || {};
  var b = (before && before[KIND_ACTIVITY[kind]]) || {};
  return LIST_BUCKETS.some(function (bucket) { return a[bucket] !== b[bucket]; });
}

function removalMoved(now, before, kind) {
  var a = (now && now[KIND_ACTIVITY[kind]]) || {};
  var b = (before && before[KIND_ACTIVITY[kind]]) || {};
  return a.removed_from_list !== b.removed_from_list;
}

function missingSlices(lists, settings) {
  return wantedSlices(settings).filter(function (s) { return !lists.pulled[s.kind + ':' + s.status]; });
}

async function listsGate(reason, settings) {
  var lists = await loadLists();
  if (!await load('plugin.snapshot', null) || missingSlices(lists, settings).length) return true;
  var age = Date.now() - await load('plugin.listsAt', 0);
  return !(age >= 0 && age < LISTS_RECHECK_MS[reason]);
}

// Two-phase sync as Simkl documents it: the activities snapshot is read before any pull and
// saved only after every pull succeeded; removals are found by diffing the ids.
async function runListOp(cx, st, settings) {
  var op = st.ops[0];
  var lists = await loadLists();
  var r;
  if (op.op === 'plan') {
    r = await simkl(cx, 'GET', '/sync/activities');
    if (!r.json || typeof r.json !== 'object') throw new PluginError('UNKNOWN', 'Simkl answered the activities check with nothing.');
    st.A = r.json;
    var snapshot = await load('plugin.snapshot', null);
    // Slices that are switched off are no longer kept current, so they must be pulled again if switched on.
    Object.keys(lists.pulled).forEach(function (k) {
      var parts = k.split(':');
      if (!sliceWanted(settings, parts[0], parts[1])) delete lists.pulled[k];
    });
    Object.keys(lists.items).forEach(function (k) {
      var it = lists.items[k];
      if (!sliceWanted(settings, it.kind, it.status)) delete lists.items[k];
    });
    await save('plugin.lists', lists);
    var next = [];
    var enabled = KINDS.filter(function (kind) { return typeEnabled(settings, kind); });
    if (snapshot && st.A.all !== snapshot.all) {
      if (enabled.some(function (kind) { return statusMoved(st.A, snapshot, kind); })) next.push({ op: 'delta', from: snapshot.all });
      if (enabled.some(function (kind) { return removalMoved(st.A, snapshot, kind); })) next.push({ op: 'ids' });
    }
    // Without a snapshot every wanted slice is pulled, even ones an earlier partial run marked.
    var pullList = snapshot ? missingSlices(lists, settings) : wantedSlices(settings);
    pullList.forEach(function (s) { next.push({ op: 'pull', kind: s.kind, status: s.status }); });
    st.ops.shift();
    st.ops = next.concat(st.ops);
    return;
  }
  if (op.op === 'pull') {
    r = await simkl(cx, 'GET', '/sync/all-items/' + KIND_ENDPOINT[op.kind] + '/' + op.status);
    Object.keys(lists.items).forEach(function (k) {
      var it = lists.items[k];
      if (it.kind === op.kind && it.status === op.status) delete lists.items[k];
    });
    mergeRows(lists, settings, op.kind, (r.json || {})[KIND_ENDPOINT[op.kind]]);
    lists.pulled[op.kind + ':' + op.status] = true;
  } else if (op.op === 'delta') {
    r = await simkl(cx, 'GET', '/sync/all-items', { query: { date_from: op.from } });
    var body = r.json || {};
    KINDS.forEach(function (kind) {
      if (typeEnabled(settings, kind)) mergeRows(lists, settings, kind, body[KIND_ENDPOINT[kind]]);
    });
  } else if (op.op === 'ids') {
    r = await simkl(cx, 'GET', '/sync/all-items', { query: { extended: 'simkl_ids_only' } });
    var current = {};
    var all = r.json || {};
    KINDS.forEach(function (kind) {
      (all[KIND_ENDPOINT[kind]] || []).forEach(function (row) {
        var media = row.show || row.movie || row.anime || row;
        if (media && media.ids && media.ids.simkl) current[itemKey(kind, media.ids.simkl)] = true;
      });
    });
    Object.keys(lists.items).forEach(function (k) {
      if (!current[k]) delete lists.items[k];
    });
  }
  await save('plugin.lists', lists);
  st.ops.shift();
}

async function listsStep(cx, prog, settings) {
  if (!prog.lists) {
    if (!await listsGate(prog.reason, settings)) return 'done';
    prog.lists = { ops: [{ op: 'plan' }] };
    await saveProgress(prog);
  }
  var st = prog.lists;
  while (st.ops.length) {
    if (Date.now() > cx.stepEnd) return 'more';
    await runListOp(cx, st, settings);
    await saveProgress(prog);
  }
  await save('plugin.snapshot', st.A);
  await save('plugin.listsAt', Date.now());
  return 'done';
}

function listIds(lists, settings, kind) {
  var ids = {};
  var items = lists.items;
  Object.keys(items).forEach(function (k) {
    var it = items[k];
    if (it.kind === kind && sliceWanted(settings, kind, it.status)) ids[it.simkl] = it;
  });
  return ids;
}

// ---------------------------------------------------------------- calendar

function compactCalendar(json, ids) {
  var entries = [];
  var meta = {};
  ((json && json.calendar) || []).forEach(function (c) {
    if (!ids[c.simkl_id]) return;
    var ep = c.episode || null;
    entries.push({
      i: c.simkl_id,
      d: c.date,
      f: c.finale_type || 0,
      s: ep && typeof ep.season === 'number' ? ep.season : null,
      e: ep && typeof ep.episode === 'number' ? ep.episode : null,
      t: ep && ep.title ? ep.title : '',
      r: ep && ep.runtime ? ep.runtime : 0,
    });
    if (!meta[c.simkl_id]) {
      var m = (json.metadata && json.metadata[String(c.simkl_id)]) || {};
      meta[c.simkl_id] = { title: m.title || '', network: m.network || '', slug: (m.ids && m.ids.slug) || '' };
    }
  });
  return { entries: entries, meta: meta };
}

function covers(cache, ids) {
  var have = {};
  cache.ids.forEach(function (id) { have[id] = true; });
  return Object.keys(ids).every(function (id) { return have[id]; });
}

async function fetchCalendar(cx, kind, ids) {
  var cache = await load('plugin.cal.' + kind, null);
  var usable = cache && covers(cache, ids);
  if (usable && cache.fetchedAt <= Date.now() && Date.now() - cache.fetchedAt < CALENDAR_MAX_AGE_MS) return;
  var headers = {};
  // A cached copy that misses a title added since must be replaced, not revalidated.
  if (usable && cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
  var r = await http(cx, { host: CDN_HOST, path: CALENDAR_PATH + (kind === 'tv' ? 'tv' : 'anime') + '.json', headers: headers });
  if (r.status === 304 && usable) {
    cache.fetchedAt = Date.now();
    await save('plugin.cal.' + kind, cache);
    return;
  }
  if (r.status !== 200 || !r.json) throw failure(r, CDN_HOST);
  var compact = compactCalendar(r.json, ids);
  await save('plugin.cal.' + kind, {
    fetchedAt: Date.now(),
    lastModified: header(r, 'last-modified') || '',
    ids: Object.keys(ids).map(Number),
    entries: compact.entries,
    meta: compact.meta,
  });
}

// A busy error is worth waiting out while backoff tries are left; after that the step carries on.
function waitable(e, prog) {
  return isBusy(e) && (!e.counts || (prog.busy || 0) < BACKOFF_MS.length);
}

// A broken calendar fetch keeps the old copy in use; the run still reports it at the end.
function defer(prog, e) {
  // A deferred error is reported once the run ends, so it is never one to wait out.
  if (!prog.deferred) prog.deferred = { code: e.code, message: e.message, state: isBusy(e) ? undefined : e.state };
}

async function calendarStep(cx, prog, settings) {
  prog.cal = prog.cal || {};
  var lists = await loadLists();
  var kinds = ['tv', 'anime'];
  for (var i = 0; i < kinds.length; i++) {
    var kind = kinds[i];
    if (prog.cal[kind]) continue;
    var ids = typeEnabled(settings, kind) ? listIds(lists, settings, kind) : {};
    if (!Object.keys(ids).length) {
      await drop('plugin.cal.' + kind);
      prog.cal[kind] = true;
      continue;
    }
    if (Date.now() > cx.stepEnd) return 'more';
    try {
      await fetchCalendar(cx, kind, ids);
    } catch (e) {
      if (isFatal(e) || waitable(e, prog)) throw e;
      defer(prog, asPluginError(e));
    }
    prog.cal[kind] = true;
    await saveProgress(prog);
  }
  return 'done';
}

// ---------------------------------------------------------------- movies

async function resolveCountry(settings) {
  if (settings.country) return settings.country;
  try {
    if (typeof Pebble.readSource === 'function') {
      var res = await Pebble.readSource({ category: 'preferences', item: 'units', properties: ['locale'] });
      var locale = res.instances[0].properties.locale.shortText.text;
      var parts = String(locale).split(/[-_]/).slice(1);
      for (var i = 0; i < parts.length; i++) {
        if (/^[A-Za-z]{2}$/.test(parts[i])) return parts[i].toUpperCase();
      }
    }
  } catch (_e) {
    // The preference is a convenience; the next fallback is documented.
  }
  return 'US';
}

function movieCandidates(lists, settings) {
  var year = new Date().getFullYear();
  var ids = listIds(lists, settings, 'movie');
  var out = [];
  Object.keys(ids).forEach(function (id) {
    var it = ids[id];
    if (it.year === null || it.year >= year - 1) out.push(it);
  });
  return out;
}

function releaseTypes(results) {
  return (results || []).filter(function (x) { return x && [2, 3, 4].indexOf(x.type) >= 0 && /^\d{4}-\d{2}-\d{2}/.test(x.release_date || ''); })
    .map(function (x) { return [x.type, x.release_date.slice(0, 10)]; });
}

function movieEntry(json, cc) {
  var rd = {};
  (json.release_dates || []).forEach(function (c) {
    var code = String(c.iso_3166_1 || '').toUpperCase();
    if (code === cc || code === 'US') rd[code] = releaseTypes(c.results);
  });
  var genres = (json.genres || []).map(function (g) { return typeof g === 'string' ? g : g && g.name; }).filter(Boolean);
  return {
    at: Date.now(),
    cc: cc,
    title: json.title || '',
    year: typeof json.year === 'number' ? json.year : null,
    runtime: parseInt(json.runtime, 10) || 0,
    genres: genres,
    slug: (json.ids && json.ids.slug) || '',
    rd: rd,
  };
}

function movieFresh(entry, cc) {
  if (!entry || entry.cc !== cc) return false;
  var age = Date.now() - entry.at;
  if (age < 0) return false;
  var today = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  var ahead = false;
  Object.keys(entry.rd || {}).forEach(function (c) {
    entry.rd[c].forEach(function (pair) { if (pair[1] >= today) ahead = true; });
  });
  return age < (ahead ? MOVIE_FRESH_AHEAD_MS : MOVIE_FRESH_MS);
}

async function fetchMovie(cx, id, cc) {
  var r = await http(cx, { host: API_HOST, path: '/movies/' + id });
  if (r.status === 404) return { at: Date.now(), cc: cc, missing: true, rd: {}, genres: [] };
  if (r.status !== 200 || !r.json) throw failure(r, API_HOST);
  return movieEntry(r.json, cc);
}

async function moviesStep(cx, prog, settings) {
  var cache = await load('plugin.movies', {});
  if (!settings.types.movies) {
    await drop('plugin.movies');
    return 'done';
  }
  var candidates = movieCandidates(await loadLists(), settings);
  var keep = {};
  candidates.forEach(function (it) { keep[it.simkl] = true; });
  Object.keys(cache).forEach(function (id) { if (!keep[id]) delete cache[id]; });
  prog.movieFailed = prog.movieFailed || {};
  var todo = candidates.filter(function (it) {
    return !movieFresh(cache[it.simkl], prog.cc) && !prog.movieFailed[it.simkl];
  });
  while (todo.length) {
    if (Date.now() > cx.stepEnd) {
      await save('plugin.movies', cache);
      return 'more';
    }
    var chunk = todo.splice(0, MOVIE_PARALLEL);
    var results = await Promise.all(chunk.map(function (it) {
      return fetchMovie(cx, it.simkl, prog.cc).then(function (entry) { return { it: it, entry: entry }; }, function (e) { return { it: it, error: e }; });
    }));
    var stop = null;
    results.forEach(function (res) {
      if (res.entry) {
        cache[res.it.simkl] = res.entry;
        return;
      }
      var e = asPluginError(res.error);
      if (isFatal(e) || waitable(e, prog)) stop = stop || e;
      else if (e.state === 'offline' || isBusy(e)) {
        defer(prog, e);
        todo.length = 0;
      } else {
        prog.movieFailed[res.it.simkl] = true;
        prog.movieFailures = (prog.movieFailures || 0) + 1;
      }
    });
    await save('plugin.movies', cache);
    await saveProgress(prog);
    if (stop) throw stop;
  }
  await save('plugin.movies', cache);
  return 'done';
}

// ---------------------------------------------------------------- items

function localAt(date, hhmm) {
  var d = date.split('-').map(Number);
  var t = hhmm.split(':').map(Number);
  return new Date(d[0], d[1] - 1, d[2], t[0], t[1], 0, 0).getTime();
}

// The release of one kind for one title: the user's country first, then the US.
function pickRelease(entry, cc, kind) {
  var preferred = kind === 'cinema' ? [3, 2] : [4];
  var countries = cc === 'US' ? ['US'] : [cc, 'US'];
  for (var c = 0; c < countries.length; c++) {
    var pairs = (entry.rd && entry.rd[countries[c]]) || [];
    for (var p = 0; p < preferred.length; p++) {
      var dates = pairs.filter(function (pair) { return pair[0] === preferred[p]; }).map(function (pair) { return pair[1]; }).sort();
      if (dates.length) return { date: dates[0], country: countries[c], fellBack: countries[c] !== cc };
    }
  }
  return null;
}

function genericTitle(title) {
  return !title || /^episode\s+\d+$/i.test(title.trim());
}

function siteLink(kind, id, slug) {
  return 'simkl.com/' + KIND_SITE[kind] + '/' + id + (slug ? '/' + slug : '');
}

function buildItems(env) {
  var s = env.settings;
  var from = env.now - PIN_PAST_WINDOW_MS;
  var to = env.now + s.daysAhead * DAY;
  var items = [];
  var seen = {};
  var add = function (item) {
    if (item.time < from || item.time > to) return;
    if (seen[item.key] || env.watched[item.key]) return;
    seen[item.key] = true;
    items.push(item);
  };

  ['tv', 'anime'].forEach(function (kind) {
    var cal = env.cal[kind];
    if (!cal || !typeEnabled(s, kind)) return;
    var ids = listIds(env.lists, s, kind);
    cal.entries.forEach(function (e) {
      var listed = ids[e.i];
      if (!listed) return;
      var meta = cal.meta[e.i] || {};
      var title = meta.title || listed.title;
      var slug = meta.slug || listed.slug;
      var base = { kind: kind, simkl: e.i, title: title, network: meta.network || '', finale: e.f, release: null, link: siteLink(kind, e.i, slug) };
      var t = Date.parse(e.d);
      if (Number.isNaN(t)) return;
      if (kind === 'anime' && e.e === null) {
        // An anime film has a day, not a time. The file counts days in Japan, where these are released.
        var day = new Date(t + 9 * HOUR).toISOString().slice(0, 10);
        add(Object.assign(base, { key: 'an-' + e.i + '-film', season: null, episode: null, time: localAt(day, s.movieTime), allDay: true, sub: 'Anime film', detail: '', runtime: 0, finale: 0 }));
        return;
      }
      if (e.e === null) return;
      var detail = genericTitle(e.t) ? '' : e.t;
      if (kind === 'tv') {
        add(Object.assign(base, { key: 'tv-' + e.i + '-' + e.s + '-' + e.e, season: e.s, episode: e.e, time: t, allDay: false, sub: 'S' + e.s + ' E' + e.e, detail: detail, runtime: e.r }));
      } else if (e.s === 0) {
        add(Object.assign(base, { key: 'an-' + e.i + '-0-' + e.e, season: 0, episode: e.e, time: t, allDay: false, sub: 'Special E' + e.e, detail: detail, runtime: e.r }));
      } else {
        add(Object.assign(base, { key: 'an-' + e.i + '-' + e.e, season: null, episode: e.e, time: t, allDay: false, sub: 'E' + e.e, detail: detail, runtime: e.r }));
      }
    });
  });

  if (s.types.movies) {
    var movies = listIds(env.lists, s, 'movie');
    var kinds = s.movieRelease === 'both' ? ['cinema', 'digital'] : [s.movieRelease];
    Object.keys(movies).forEach(function (id) {
      var listed = movies[id];
      var entry = env.movies[id];
      if (!entry || entry.missing || entry.cc !== env.cc) return;
      kinds.forEach(function (release) {
        var pick = pickRelease(entry, env.cc, release);
        if (!pick) return;
        var time = localAt(pick.date, s.movieTime);
        var year = entry.year || listed.year;
        add({
          kind: 'movie', simkl: listed.simkl, key: 'mv-' + id + '-' + release, season: null, episode: null, time: time, allDay: true,
          title: entry.title || listed.title, sub: release === 'cinema' ? 'In cinemas' : 'Digital release',
          detail: [year, entry.genres.slice(0, 2).join(', ')].filter(Boolean).join(' \u00b7 '),
          network: '', runtime: entry.runtime, finale: 0, release: release,
          link: siteLink('movie', id, entry.slug || listed.slug),
          note: pick.fellBack ? 'No release date listed for ' + env.cc + '. Showing the US date.' : '',
        });
      });
    });
  }
  items.sort(function (a, b) { return a.time - b.time || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.key < b.key ? -1 : 1); });
  return items;
}

// ---------------------------------------------------------------- pins

function hashOf(text) {
  var a = 5381;
  var b = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    a = ((a << 5) + a + c) | 0;
    b = (c + (b << 6) + (b << 16) - b) | 0;
  }
  return (a >>> 0).toString(16) + (b >>> 0).toString(16) + ':' + text.length;
}

function actionArgs(item) {
  var args = { kind: item.kind, simkl: item.simkl };
  if (item.season !== null) args.season = item.season;
  if (item.episode !== null) args.episode = item.episode;
  return args;
}

function pinFor(item, settings) {
  var subtitle = item.sub + (item.finale ? ' \u00b7 ' + FINALE_TEXT[item.finale] : '');
  var icon = item.kind === 'movie' ? 'system://images/MOVIE_EVENT' : 'system://images/TV_SHOW';
  var lines = [];
  if (item.detail) lines.push(item.detail);
  var facts = [item.network, item.runtime ? item.runtime + ' min' : ''].filter(Boolean).join(' \u00b7 ');
  if (facts) lines.push(facts);
  if (item.note) lines.push(item.note);
  lines.push(item.link);
  var pin = {
    time: new Date(item.time).toISOString(),
    layout: { type: 'genericPin', title: item.title, subtitle: subtitle, body: lines.join('\n'), tinyIcon: icon, largeIcon: icon },
  };
  if (!item.allDay && item.runtime) pin.duration = item.runtime;
  if (settings.reminder >= 0) {
    var at = item.allDay ? item.time : item.time - settings.reminder * MINUTE;
    pin.reminders = [{ time: new Date(at).toISOString(), layout: { type: 'genericReminder', title: item.title + ': ' + item.sub, tinyIcon: icon } }];
  }
  pin.actions = [{ type: 'pluginAction', title: 'Mark watched', action: 'mark_watched', args: actionArgs(item) }];
  return pin;
}

// The first id for a key that was never deleted: the phone ignores inserts under a deleted id.
function pinIdFor(key, pins) {
  var id = key;
  for (var n = 2; pins[id] && pins[id].deleted; n++) id = key + '-' + n;
  return id;
}

function parseKey(key) {
  var m = /^(tv|an|mv)-(\d+)-/.exec(key);
  if (!m) return null;
  return { kind: m[1] === 'tv' ? 'tv' : m[1] === 'an' ? 'anime' : 'movie', simkl: Number(m[2]) };
}

function pinPermissionError(e) {
  if (e && e.name === 'NotAllowedError') return permissionError('timeline');
  return asPluginError(e);
}

async function reconcilePins(env, items) {
  var s = env.settings;
  var pins = await load('pins', {});
  var wanted = {};
  items.forEach(function (item) { wanted[item.key] = item; });
  var live = {};
  Object.keys(pins).forEach(function (id) {
    if (!pins[id].deleted) live[pins[id].key] = id;
  });
  var present = { tv: listIds(env.lists, s, 'tv'), anime: listIds(env.lists, s, 'anime'), movie: listIds(env.lists, s, 'movie') };
  try {
    for (var id in pins) {
      var rec = pins[id];
      if (rec.deleted || wanted[rec.key]) continue;
      var parsed = parseKey(rec.key);
      // A title that left the lists, or a type switched off, goes at once; anything else
      // that is merely out of the window stays until it is in the past.
      var gone = !parsed || !typeEnabled(s, parsed.kind) || !present[parsed.kind][parsed.simkl];
      if (gone || rec.time > env.now) {
        await Pebble.deleteTimelinePin(id);
        rec.deleted = true;
        delete live[rec.key];
      }
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var pin = pinFor(item, s);
      var hash = hashOf(JSON.stringify(pin));
      var existing = live[item.key];
      if (existing && pins[existing].hash === hash) continue;
      var pinId = existing || pinIdFor(item.key, pins);
      var full = { id: pinId };
      for (var k in pin) full[k] = pin[k];
      await Pebble.insertTimelinePin(full);
      pins[pinId] = { key: item.key, time: item.time, hash: hash };
      live[item.key] = pinId;
    }
  } catch (e) {
    throw pinPermissionError(e);
  } finally {
    // mark_watched may have deleted a pin while this ran; its flag must not be overwritten.
    var stored = await load('pins', {});
    Object.keys(stored).forEach(function (pid) {
      if (stored[pid].deleted && pins[pid]) pins[pid].deleted = true;
    });
    Object.keys(pins).forEach(function (pid) {
      if (pins[pid].time < env.now - PIN_KEEP_MS) delete pins[pid];
    });
    await save('pins', pins);
  }
  return live;
}

async function pinsStep(_cx, prog, settings) {
  var now = Date.now();
  var watched = await load('plugin.watched', {});
  Object.keys(watched).forEach(function (k) { if (watched[k] < now - PIN_KEEP_MS) delete watched[k]; });
  await save('plugin.watched', watched);
  var env = {
    now: now,
    settings: settings,
    cc: prog.cc,
    watched: watched,
    lists: await loadLists(),
    cal: { tv: await load('plugin.cal.tv', null), anime: await load('plugin.cal.anime', null) },
    movies: await load('plugin.movies', {}),
  };
  var items = buildItems(env);
  var live = await reconcilePins(env, items);
  var upcoming = items.filter(function (i) { return i.time >= now - UPCOMING_PAST_MS; }).slice(0, UPCOMING_MAX).map(function (i) {
    return {
      kind: i.kind, simkl: i.simkl, season: i.season, episode: i.episode, time: Math.floor(i.time / 1000), allDay: i.allDay,
      title: i.title, sub: i.sub, detail: i.detail, network: i.network, runtime: i.runtime, finale: i.finale, release: i.release,
      pinId: live[i.key] || '',
    };
  });
  await save('upcoming', { generatedAt: now, items: upcoming });
  return 'done';
}

// ---------------------------------------------------------------- sync

async function saveProgress(prog) {
  await save('plugin.sync', prog);
}

var STEPS = { lists: listsStep, calendar: calendarStep, movies: moviesStep, pins: pinsStep };

function makeContext(full) {
  return { stepEnd: Date.now() + (full ? FULL_STEP_BUDGET_MS : STEP_BUDGET_MS), fresh: !!full, owner: null };
}

// One sync at a time: two runs would interleave read-modify-write of the pin records, and a lost
// `deleted` flag makes the next insert reuse an id the Pebble app ignores for good.
async function tryLock(owner) {
  var held = await load('plugin.syncLock', null);
  if (held && held.until > Date.now() && held.owner !== owner) return false;
  await save('plugin.syncLock', { owner: owner, until: Date.now() + LOCK_TTL_MS });
  // Another invocation may have checked at the same moment; the last write wins, so read it back.
  var mine = await load('plugin.syncLock', null);
  return !!mine && mine.owner === owner;
}

async function renewLock(cx) {
  if (cx.owner) await save('plugin.syncLock', { owner: cx.owner, until: Date.now() + LOCK_TTL_MS });
}

async function releaseLock(owner) {
  var held = await load('plugin.syncLock', null);
  if (held && held.owner === owner) await drop('plugin.syncLock');
}

// Never waits for the lock: the caller asks again after LOCK_RETRY_MS.
async function acquireLock(cx, owner) {
  if (!await tryLock(owner)) return false;
  cx.owner = owner;
  return true;
}

async function withLock(cx, fn) {
  var owner = newOwner();
  if (!await acquireLock(cx, owner)) throw busyError('A sync is running. Try again in a moment.', LOCK_RETRY_MS, false);
  try {
    return await fn();
  } finally {
    await releaseLock(owner);
    cx.owner = null;
  }
}

function newOwner() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function statusFor(e) {
  return await writeStatus(false, e.state, e.message);
}

// One invocation of the sync: 'done'; 'more' when work is left and the caller should call again
// at once; or 'wait:<ms>' when it should call again after that long.
async function syncOnce(reason, cx) {
  var owner = newOwner();
  if (!await acquireLock(cx, owner)) return waitAnswer(LOCK_RETRY_MS);
  try {
    return await runSync(reason, cx);
  } finally {
    await releaseLock(owner);
    cx.owner = null;
  }
}

async function runSync(reason, cx) {
  var settings = await getSettings();
  var prog = null;
  try {
    requirePinApi();
    await requirePermissions(['simkl', 'cdn', 'timeline']);
    if (!await load('account', null)) throw new PluginError('AUTH_REQUIRED', 'Sign in to Simkl to see upcoming episodes.');
    if (reason !== 'scheduled' && !(await readTokens())) {
      await clearCredentials();
      throw new PluginError('AUTH_REQUIRED', 'Sign in to Simkl to see upcoming episodes.');
    }
    prog = cx.fresh ? null : await load('plugin.sync', null);
    cx.fresh = false; // a full run starts over once, then continues its own progress
    var age = prog ? Date.now() - prog.startedAt : 0;
    if (!prog || prog.reason !== reason || age > STALE_RUN_MS || age < 0) {
      prog = {
        startedAt: Date.now(),
        reason: reason,
        steps: reason === 'scheduled' ? ['calendar', 'movies', 'pins'] : ['lists', 'calendar', 'movies', 'pins'],
        i: 0,
        cc: await resolveCountry(settings),
      };
      await saveProgress(prog);
    }
    while (prog.i < prog.steps.length) {
      if (prog.i > 0 && Date.now() > cx.stepEnd) return 'more';
      await renewLock(cx);
      if ((await STEPS[prog.steps[prog.i]](cx, prog, settings)) === 'more') return 'more';
      prog.i++;
      prog.busy = 0;
      await saveProgress(prog);
    }
    await drop('plugin.sync');
    if (prog.deferred) throw new PluginError(prog.deferred.code, prog.deferred.message, prog.deferred.state);
    var pins = (await liveRecords()).length;
    var note = prog.movieFailures ? ' ' + prog.movieFailures + ' movie dates could not be checked.' : '';
    await writeStatus(true, 'ok', pins + (pins === 1 ? ' item' : ' items') + ' on your timeline.' + note);
    return 'done';
  } catch (e) {
    var err = asPluginError(e);
    if (isBusy(err) && prog) {
      // Waiting keeps the progress and the last status; only a Simkl that stays busy is reported.
      var tries = prog.busy || 0;
      if (!err.counts || tries < BACKOFF_MS.length) {
        if (err.counts) prog.busy = tries + 1;
        await saveProgress(prog);
        return waitAnswer(err.retryAfterMs || BACKOFF_MS[tries]);
      }
      prog.busy = 0;
      await saveProgress(prog);
      err = new PluginError('UNKNOWN', err.message);
    }
    if (isFatal(err)) await drop('plugin.sync');
    await statusFor(err);
    throw err;
  }
}

// The config page runs everything in one go. When the run has to wait, the answer carries
// retryAfterMs and the page sends syncNow with resume after that long.
async function syncFully(reason, resume) {
  var cx = makeContext(true);
  if (resume) cx.fresh = false;
  var answer = 'done';
  try {
    do {
      answer = await syncOnce(reason, cx);
    } while (answer === 'more');
  } catch (_e) {
    // syncOnce stored the failure in sync_status.
  }
  return { status: await load('sync_status', null), retryAfterMs: waitOf(answer) || undefined };
}

// ---------------------------------------------------------------- mark watched

function historyBody(args) {
  var ids = { simkl: args.simkl };
  if (args.kind === 'movie') return { movies: [{ ids: ids }] };
  if (args.kind === 'tv') {
    return { shows: [{ ids: ids, seasons: [{ number: args.season, episodes: [{ number: args.episode }] }] }] };
  }
  // An anime film is a title in the anime catalog: Simkl wants it under shows[], whole, with no episodes.
  if (!Number.isInteger(args.episode)) return { shows: [{ ids: ids }] };
  // Anime numbering is flat (AniDB): one season, 1. Specials are season 0.
  return { shows: [{ ids: ids, seasons: [{ number: args.season === 0 ? 0 : 1, episodes: [{ number: args.episode }] }] }] };
}

function keysFor(args) {
  if (args.kind === 'movie') return ['mv-' + args.simkl + '-cinema', 'mv-' + args.simkl + '-digital'];
  if (args.kind === 'tv') return ['tv-' + args.simkl + '-' + args.season + '-' + args.episode];
  if (!Number.isInteger(args.episode)) return ['an-' + args.simkl + '-film'];
  return ['an-' + args.simkl + (args.season === 0 ? '-0-' : '-') + args.episode];
}

function validateWatchedArgs(a) {
  var bad = function (m) { return new PluginError('INVALID_ARGS', m); };
  if (!a || KINDS.indexOf(a.kind) < 0) return bad('kind must be tv, anime or movie.');
  if (!Number.isInteger(a.simkl)) return bad('simkl must be a whole number.');
  if (a.kind === 'tv' && !(Number.isInteger(a.season) && Number.isInteger(a.episode))) return bad('A TV episode needs a season and an episode.');
  if (a.kind === 'anime' && a.episode !== undefined && !Number.isInteger(a.episode)) return bad('episode must be a whole number.');
  return null;
}

async function markWatched(cx, args) {
  var invalid = validateWatchedArgs(args);
  if (invalid) throw invalid;
  await requirePermissions(hasPinApi() ? ['simkl', 'timeline'] : ['simkl']);
  var r = await simkl(cx, 'POST', '/sync/history', { json: historyBody(args) });
  var missing = r.json && r.json.not_found;
  if (missing && ((missing.movies || []).length || (missing.shows || []).length || (missing.episodes || []).length)) {
    throw new PluginError('UNKNOWN', 'Simkl could not find that title or episode.');
  }
  var keys = keysFor(args);
  var known = {};
  var upcoming = await load('upcoming', null);
  ((upcoming && upcoming.items) || []).forEach(function (i) {
    keysForItem(i).forEach(function (k) { known[k] = i.time * 1000; });
  });
  var pins = await load('pins', {});
  var targets = Object.keys(pins).filter(function (id) { return !pins[id].deleted && keys.indexOf(pins[id].key) >= 0; });
  targets.forEach(function (id) { known[pins[id].key] = pins[id].time; });
  var failed = null;
  var done = [];
  for (var i = 0; i < targets.length; i++) {
    try {
      if (hasPinApi()) await Pebble.deleteTimelinePin(targets[i]);
      done.push(targets[i]);
    } catch (e) {
      failed = failed || e;
    }
  }
  // Everything is read again right before it is written: a sync may have run meanwhile.
  await markDeleted(done);
  var watched = await load('plugin.watched', {});
  keys.forEach(function (k) { watched[k] = known[k] || Date.now(); });
  await save('plugin.watched', watched);
  upcoming = await load('upcoming', null);
  if (upcoming && upcoming.items) {
    upcoming.items = upcoming.items.filter(function (i) {
      return !keysForItem(i).some(function (k) { return keys.indexOf(k) >= 0; });
    });
    await save('upcoming', upcoming);
  }
  if (failed) throw pinPermissionError(failed);
  return 'Marked watched';
}

function keysForItem(i) {
  return keysFor({ kind: i.kind, simkl: i.simkl, season: i.season === null ? undefined : i.season, episode: i.episode === null ? undefined : i.episode });
}

// Everything the watch app shows, as JSON: PKJS can't read the plugin's storage.
async function watchData() {
  var settings = await getSettings();
  var upcoming = await load('upcoming', null);
  return JSON.stringify({
    account: await load('account', null),
    signin: await publicSignin(),
    status: await load('sync_status', null),
    syncTimes: settings.syncTimes,
    items: (upcoming && upcoming.items) || [],
  });
}

// ---------------------------------------------------------------- handlers

function replyError(respond, e) {
  var err = asPluginError(e);
  respond.error(err.code, err.message);
}

Pebble.registerActionHandler(async function (request, respond) {
  var args = (request && request.args) || {};
  try {
    switch (request && request.action) {
      case 'sync': {
        if (['scheduled', 'open', 'manual', 'settings'].indexOf(args.reason) < 0) throw new PluginError('INVALID_ARGS', 'reason must be scheduled, open, manual or settings.');
        respond.ok({ text: await syncOnce(args.reason, makeContext(false)) });
        return;
      }
      case 'mark_watched':
        respond.ok({ text: await markWatched(makeContext(false), args) });
        return;
      case 'signin_start':
        respond.ok({ text: (await startSignin(makeContext(false))).userCode });
        return;
      case 'signin_poll':
        respond.ok({ text: await pollSignin(makeContext(false)) });
        return;
      case 'watch_data':
        respond.ok({ text: await watchData() });
        return;
      default:
        respond.error('INVALID_REQUEST', 'Unknown action.');
    }
  } catch (e) {
    replyError(respond, e);
  }
});

async function publicSignin() {
  var signin = await load('signin', null);
  if (signin && Date.now() >= signin.expiresAt) {
    await endSignin();
    return null;
  }
  return signin;
}

Pebble.registerConfigHandler(async function (message, respond) {
  var type = message && message.type;
  try {
    switch (type) {
      case 'state':
        respond({
          account: await load('account', null),
          signin: await publicSignin(),
          settings: await getSettings(),
          status: await load('sync_status', null),
          permissions: await permissionStates(),
          version: APP_VERSION,
        });
        return;
      case 'saveSettings': {
        var checked = validateSettings(message.settings, await getSettings());
        if (checked.error) {
          respond({ ok: false, error: checked.error });
          return;
        }
        await save('settings', checked.value);
        var saved = await syncFully('settings');
        respond({ ok: true, status: saved.status, retryAfterMs: saved.retryAfterMs });
        return;
      }
      case 'signinStart':
        respond({ signin: await startSignin(makeContext(true)) });
        return;
      case 'signinPoll': {
        var state;
        try {
          state = await pollSignin(makeContext(true));
        } catch (e) {
          respond({ state: 'error', error: asPluginError(e).message });
          return;
        }
        if (state !== 'approved') {
          respond({ state: state });
          return;
        }
        var first = await syncFully('manual');
        respond({ state: 'approved', account: await load('account', null), status: first.status, retryAfterMs: first.retryAfterMs });
        return;
      }
      case 'signout': {
        var cx = makeContext(true);
        respond(await withLock(cx, function () { return signOut(cx); }));
        return;
      }
      case 'syncNow': {
        // resume carries on a run that had to wait, under the reason it started with.
        var reason = message.reason === 'settings' ? 'settings' : 'manual';
        var result = await syncFully(reason, !!message.resume);
        respond({ ok: !!(result.status && result.status.ok), status: result.status, retryAfterMs: result.retryAfterMs });
        return;
      }
      default:
        respond({ error: 'unknown message type' });
    }
  } catch (e) {
    var err = asPluginError(e);
    // A busy error did nothing, so the page sends the same message again after the wait.
    respond({ error: err.message, retryAfterMs: isBusy(err) ? (err.retryAfterMs || BACKOFF_MS[0]) : undefined });
  }
});
