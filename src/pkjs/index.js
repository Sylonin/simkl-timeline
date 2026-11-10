// Bridge between the watch app (AppMessage) and the Simkl Timeline plugin (Pebble.invokeAction).
// The plugin owns all Simkl logic and its own storage; this file asks it for what the watch shows.
var qrcode = require('qrcode-generator');

var PLUGIN_UUID = '4b7b70e6-67aa-4071-a811-2c4f6cfa316f';

var CMD_HELLO = 1;
var CMD_SYNC = 2;
var CMD_SIGNIN_START = 3;
var CMD_SIGNIN_STOP = 4;
var CMD_MARK_WATCHED = 5;

var CMD_STATUS = 10;
var CMD_ITEMS_BEGIN = 11;
var CMD_ITEM = 12;
var CMD_ITEMS_END = 13;
var CMD_SIGNIN_CODE = 14;
var CMD_SIGNIN_RESULT = 15;
var CMD_SCHEDULE = 16;
var CMD_RESULT = 17;
var CMD_READY = 18;

var ST_READY = 0;
var ST_SYNCING = 1;
var ST_SIGNED_OUT = 2;
var ST_NEEDS_PLUGINS = 3;
var ST_PERMISSION = 4;
var ST_OFFLINE = 5;
var ST_ERROR = 6;

var MAX_ITEMS = 16;
var MAX_SYNC_CALLS = 10;
var MAX_SYNC_MS = 50000;
var INVOKE_GUARD_MS = 30000;
var NACK_RETRIES = 2;
var SIGNIN_MAX_FAILURES = 3;

var TEXT_PLUGINS = 'Turn on plugins in the Pebble app (Settings \u2192 Plugins), version 1.18 or later';
var TEXT_SIGNED_OUT = 'Sign in to Simkl to see your shows.';
var TEXT_PERMISSION = 'Allow Simkl Timeline in the Pebble app permissions.';
var TEXT_OFFLINE = 'No connection to Simkl. Try again later.';
var TEXT_TIMEOUT = 'Simkl took too long. Try again.';
var TEXT_BUSY = 'Simkl is busy. Try again later.';
var TEXT_ERROR = 'Something went wrong. Try again later.';

var KINDS = { tv: 0, anime: 1, movie: 2 };
var KIND_NAMES = ['tv', 'anime', 'movie'];

// localStorage

function load(key) {
  var raw;
  try {
    raw = localStorage.getItem(key);
  } catch (e) {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch (e2) {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.log('localStorage write failed: ' + e);
  }
}

// Strings

// The longest prefix of s within budget UTF-8 bytes, on a character boundary.
function takeUtf8(s, budget) {
  var out = '';
  var bytes = 0;
  var i = 0;
  while (i < s.length) {
    var cp = s.charCodeAt(i);
    var units = 1;
    var piece;
    var size;
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length &&
        s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
      units = 2;
      size = 4;
      piece = s.substr(i, 2);
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      size = 3;
      piece = '\ufffd';
    } else {
      size = cp < 0x80 ? 1 : (cp < 0x800 ? 2 : 3);
      piece = s.charAt(i);
    }
    if (bytes + size > budget) return { text: out, cut: true };
    out += piece;
    bytes += size;
    i += units;
  }
  return { text: out, cut: false };
}

// Cut to at most maxBytes UTF-8 bytes including the NUL the watch adds, on a character boundary.
// A cut string ends in an ellipsis (3 bytes) so it doesn't read as a typo.
function truncateUtf8(value, maxBytes) {
  var s = String(value === null || value === undefined ? '' : value).replace(/[\r\n\t]+/g, ' ');
  var whole = takeUtf8(s, maxBytes - 1);
  if (!whole.cut) return whole.text.replace(/\s+$/, '');
  return takeUtf8(s, maxBytes - 4).text.replace(/\s+$/, '') + '\u2026';
}

function hashString(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16) + ':' + s.length;
}

// Serial AppMessage queue: one message in flight, NACKs retried with backoff.
// A group is a set of messages that is delivered whole or abandoned together.

var queue = [];
var inFlight = null;

function enqueue(messages, done) {
  var group = { remaining: messages.length, failed: false, done: done || null };
  for (var i = 0; i < messages.length; i++) {
    queue.push({ msg: messages[i], group: group, tries: 0 });
  }
  pump();
}

function settleGroup(group, ok) {
  if (group.done) {
    var cb = group.done;
    group.done = null;
    cb(ok);
  }
}

function abandonGroup(group) {
  group.failed = true;
  queue = queue.filter(function (entry) {
    return entry.group !== group;
  });
  settleGroup(group, false);
}

function pump() {
  if (inFlight || queue.length === 0) return;
  var entry = queue[0];
  var settled = false;
  inFlight = entry;

  function ack() {
    if (settled) return;
    settled = true;
    inFlight = null;
    queue.shift();
    entry.group.remaining--;
    if (entry.group.remaining === 0 && !entry.group.failed) settleGroup(entry.group, true);
    pump();
  }

  function nack() {
    if (settled) return;
    settled = true;
    entry.tries++;
    if (entry.tries <= NACK_RETRIES) {
      setTimeout(function () {
        inFlight = null;
        pump();
      }, entry.tries * 800);
      return;
    }
    inFlight = null;
    abandonGroup(entry.group);
    pump();
  }

  try {
    Pebble.sendAppMessage(entry.msg, ack, nack);
  } catch (e) {
    console.log('sendAppMessage threw: ' + e);
    nack();
  }
}

// Plugin calls

function pluginAvailable() {
  return typeof Pebble.invokeAction === 'function';
}

// Always calls back exactly once with {ok, text} or {ok:false, code, message}.
function invoke(action, args, callback) {
  var done = false;
  var guard = null;

  function finish(result) {
    if (done) return;
    done = true;
    clearTimeout(guard);
    callback(result);
  }

  if (!pluginAvailable()) {
    finish({ ok: false, code: 'PLUGIN_UNAVAILABLE', message: '' });
    return;
  }
  guard = setTimeout(function () {
    finish({ ok: false, code: 'TIMEOUT', message: '' });
  }, INVOKE_GUARD_MS);
  try {
    Pebble.invokeAction({ plugin: PLUGIN_UUID, action: action, args: args || {} }).then(
      function (result) {
        finish(result && typeof result === 'object' ? result : { ok: false, code: 'UNKNOWN', message: '' });
      },
      function (err) {
        finish({
          ok: false,
          code: (err && err.code) || 'UNKNOWN',
          message: (err && err.message) || String(err || '')
        });
      }
    );
  } catch (e) {
    finish({ ok: false, code: 'PLUGIN_UNAVAILABLE', message: String(e) });
  }
}

// What the plugin last reported through watch_data: { account, signin, status, syncTimes, items }.
// The plugin's storage is private, and on Android this file's localStorage is a copy that the
// plugin's writes never reach. The copy kept here shows the last list at once on the next launch.
var data = load('pkjs.data');

function fetchData(callback) {
  invoke('watch_data', {}, function (result) {
    if (result.ok) {
      try {
        data = JSON.parse(result.text);
        save('pkjs.data', data);
      } catch (e) {
        result = { ok: false, code: 'UNKNOWN', message: '' };
      }
    }
    callback(result);
  });
}

// Maps a failed action result to a watch status: {state, text}.
function errorToStatus(result) {
  var code = result.code;
  var message = result.message || '';
  if (code === 'PLUGIN_UNAVAILABLE') {
    // The plugin runs, but this Pebble app is too old for it: the plugin says so in its status.
    var why = data && data.status;
    return { state: ST_NEEDS_PLUGINS, text: why && why.state === 'needs_update' && why.message ? why.message : TEXT_PLUGINS };
  }
  if (code === 'AUTH_REQUIRED') return { state: ST_SIGNED_OUT, text: TEXT_SIGNED_OUT };
  if (code === 'PERMISSION_DENIED') return { state: ST_PERMISSION, text: message || TEXT_PERMISSION };
  if (code === 'TIMEOUT') return { state: ST_ERROR, text: TEXT_TIMEOUT };
  if (code === 'RATE_LIMITED') return { state: ST_ERROR, text: TEXT_BUSY };
  var stored = data && data.status;
  if (stored && stored.state === 'offline') return { state: ST_OFFLINE, text: message || TEXT_OFFLINE };
  return { state: ST_ERROR, text: message || TEXT_ERROR };
}

// Watch status

function lastSyncSeconds() {
  var at = data && data.status && data.status.lastOkAt;
  return typeof at === 'number' && at > 0 ? Math.floor(at / 1000) : 0;
}

function storedStatus() {
  var status = data && data.status;
  if (!data || !data.account) return { state: ST_SIGNED_OUT, text: TEXT_SIGNED_OUT };
  if (!status) return { state: ST_READY, text: '' };
  var message = status.message || '';
  switch (status.state) {
    case 'signed_out': return { state: ST_SIGNED_OUT, text: TEXT_SIGNED_OUT };
    case 'permission': return { state: ST_PERMISSION, text: message || TEXT_PERMISSION };
    case 'offline': return { state: ST_OFFLINE, text: message || TEXT_OFFLINE };
    case 'needs_update': return { state: ST_NEEDS_PLUGINS, text: message || TEXT_PLUGINS };
    case 'error': return { state: ST_ERROR, text: message || TEXT_ERROR };
    default: return { state: ST_READY, text: '' };
  }
}

function sendStatus(status) {
  enqueue([{
    Cmd: CMD_STATUS,
    State: status.state,
    Text: truncateUtf8(status.text, 96),
    LastSync: lastSyncSeconds()
  }]);
}

var sentSchedule = '';

// Only times the plugin reported: guessed defaults would overwrite the watch's own copy.
function sendSchedule(onlyIfChanged) {
  var times = data && data.syncTimes;
  if (!times) return;
  var msg = {
    Cmd: CMD_SCHEDULE,
    SyncTime1: typeof times[0] === 'number' ? times[0] : 360,
    SyncTime2: typeof times[1] === 'number' ? times[1] : -1
  };
  var key = msg.SyncTime1 + ',' + msg.SyncTime2;
  if (onlyIfChanged && key === sentSchedule) return;
  sentSchedule = key;
  enqueue([msg]);
}

// Items

function itemFlags(item) {
  var kind = KINDS[item.kind];
  if (kind === undefined) kind = 0;
  var finale = Math.max(0, Math.min(3, item.finale | 0));
  return kind | (item.allDay ? 4 : 0) | (finale << 3) | (item.release === 'digital' ? 32 : 0);
}

function itemMessages() {
  var items = data && data.items instanceof Array ? data.items.slice(0, MAX_ITEMS) : [];
  var messages = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    messages.push({
      Cmd: CMD_ITEM,
      Index: i,
      ItemTime: item.time | 0,
      ItemFlags: itemFlags(item),
      ItemRuntime: item.runtime | 0,
      ItemSimkl: item.simkl | 0,
      ItemSeason: typeof item.season === 'number' ? item.season : -1,
      ItemEpisode: typeof item.episode === 'number' ? item.episode : -1,
      ItemTitle: truncateUtf8(item.title, 40),
      ItemSub: truncateUtf8(item.sub, 24),
      ItemDetail: truncateUtf8(item.detail, 40),
      ItemNetwork: truncateUtf8(item.network, 20)
    });
  }
  return messages;
}

var queuedHash = null;

// Sends the cached list unless the watch already has, or is about to get, exactly this list.
function sendItems(force) {
  var items = itemMessages();
  var hash = hashString(JSON.stringify(items));
  if (!force && (load('pkjs.sentHash') === hash || queuedHash === hash)) return;
  queuedHash = hash;
  var messages = [{ Cmd: CMD_ITEMS_BEGIN, Count: items.length }].concat(items);
  messages.push({ Cmd: CMD_ITEMS_END, Count: items.length, LastSync: lastSyncSeconds() });
  enqueue(messages, function (ok) {
    if (ok) save('pkjs.sentHash', hash);
    if (queuedHash === hash) queuedHash = null;
  });
}

// Sync loop. Reasons rank manual > open > scheduled; a request that arrives mid-sync is
// remembered and run afterwards unless the running sync already covers it.

var RANK = { scheduled: 0, open: 1, manual: 2 };
var syncRunning = null;
var syncPending = null;

function requestSync(reason, force) {
  if (!pluginAvailable()) {
    sendStatus({ state: ST_NEEDS_PLUGINS, text: TEXT_PLUGINS });
    return;
  }
  if (syncRunning) {
    sendStatus({ state: ST_SYNCING, text: 'Syncing' });
    if (force || RANK[reason] > RANK[syncRunning]) {
      if (!syncPending || RANK[reason] > RANK[syncPending]) syncPending = reason;
    }
    return;
  }
  runSync(reason);
}

function runSync(reason) {
  syncRunning = reason;
  var started = Date.now();
  var calls = 0;
  sendStatus({ state: ST_SYNCING, text: 'Syncing' });

  function finish(status) {
    syncRunning = null;
    sendSchedule(true);
    sendStatus(status);
    sendItems(false);
    if (syncPending) {
      var next = syncPending;
      syncPending = null;
      runSync(next);
    }
  }

  // Asks the plugin what the run left behind, then shows it. A plugin that hung would not answer
  // that either.
  function complete(result) {
    if (!result.ok && result.code === 'TIMEOUT') {
      finish(errorToStatus(result));
      return;
    }
    fetchData(function () {
      if (!result.ok) {
        finish(errorToStatus(result));
        return;
      }
      var stored = storedStatus();
      finish(stored.state === ST_SIGNED_OUT ? { state: ST_READY, text: '' } : stored);
    });
  }

  function step() {
    calls++;
    invoke('sync', { reason: reason }, function (result) {
      if (!result.ok) {
        complete(result);
        return;
      }
      // 'more': call again now. 'wait:<ms>': the plugin can't wait itself (no timers there), so we do.
      var wait = /^wait:(\d+)$/.exec(result.text || '');
      var delay = wait ? Number(wait[1]) : 0;
      if ((result.text === 'more' || wait) && calls < MAX_SYNC_CALLS && Date.now() + delay - started < MAX_SYNC_MS) {
        if (wait) setTimeout(step, delay);
        else step();
        return;
      }
      complete(result);
    });
  }

  step();
}

// Sign-in

var signinGeneration = 0;
var signinTimer = null;

function stopSignin() {
  signinGeneration++;
  if (signinTimer !== null) {
    clearTimeout(signinTimer);
    signinTimer = null;
  }
}

function makeQr(url) {
  var qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  var size = qr.getModuleCount();
  var bytes = [];
  var total = size * size;
  for (var b = 0; b < Math.ceil(total / 8); b++) bytes.push(0);
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      if (qr.isDark(y, x)) {
        var i = y * size + x;
        bytes[i >> 3] |= 0x80 >> (i & 7);
      }
    }
  }
  return { size: size, data: bytes };
}

function signinResult(state, text) {
  enqueue([{ Cmd: CMD_SIGNIN_RESULT, State: state, Text: truncateUtf8(text, 96) }]);
}

function signinFailure(result) {
  var status = errorToStatus(result);
  if (status.state === ST_NEEDS_PLUGINS || status.state === ST_PERMISSION) sendStatus(status);
  signinResult(2, status.state === ST_SIGNED_OUT ? TEXT_ERROR : status.text);
}

function startSignin() {
  stopSignin();
  var generation = signinGeneration;
  invoke('signin_start', {}, function (result) {
    if (generation !== signinGeneration) return;
    if (!result.ok) {
      signinFailure(result);
      return;
    }
    // The code's link and timings are in the plugin's storage.
    fetchData(function () {
      if (generation !== signinGeneration) return;
      var signin = data && data.signin;
      if (!signin || !signin.uriComplete) {
        signinResult(2, 'Could not start sign-in. Try again.');
        return;
      }
      var qr;
      try {
        qr = makeQr(signin.uriComplete);
      } catch (e) {
        signinResult(2, 'Could not make the QR code. Use the code instead.');
        return;
      }
      enqueue([{
        Cmd: CMD_SIGNIN_CODE,
        Code: truncateUtf8(signin.userCode || result.text, 24),
        Expires: Math.floor(signin.expiresAt / 1000),
        QrSize: qr.size,
        QrData: qr.data
      }]);
      var interval = Math.max(1, signin.interval || 5);
      pollSignin(generation, signin.expiresAt, interval, 0);
    });
  });
}

function pollSignin(generation, expiresAt, interval, failures) {
  signinTimer = setTimeout(function () {
    signinTimer = null;
    if (generation !== signinGeneration) return;
    if (Date.now() >= expiresAt) {
      signinResult(1, 'The code expired. Try again.');
      return;
    }
    invoke('signin_poll', {}, function (result) {
      if (generation !== signinGeneration) return;
      if (result.ok && result.text === 'pending') {
        pollSignin(generation, expiresAt, interval, 0);
      } else if (result.ok && result.text === 'approved') {
        fetchData(function () {
          var account = data && data.account;
          signinResult(0, account && account.name ? 'Signed in as ' + account.name : 'Signed in');
          requestSync('manual', true);
        });
      } else if (result.ok && result.text === 'expired') {
        signinResult(1, 'The code expired. Try again.');
      } else if (!result.ok && result.code !== 'AUTH_REQUIRED' && result.code !== 'PLUGIN_UNAVAILABLE' &&
                 result.code !== 'PERMISSION_DENIED' && failures + 1 < SIGNIN_MAX_FAILURES) {
        pollSignin(generation, expiresAt, interval, failures + 1);
      } else {
        signinFailure(result.ok ? { ok: false, code: 'UNKNOWN', message: '' } : result);
      }
    });
  }, interval * 1000);
}

// Mark watched

function markWatched(payload) {
  var flags = payload.ItemFlags | 0;
  var args = { kind: KIND_NAMES[flags & 3] || 'tv', simkl: payload.ItemSimkl | 0 };
  if (typeof payload.ItemSeason === 'number' && payload.ItemSeason >= 0) args.season = payload.ItemSeason;
  if (typeof payload.ItemEpisode === 'number' && payload.ItemEpisode >= 0) args.episode = payload.ItemEpisode;
  invoke('mark_watched', args, function (result) {
    if (result.ok) {
      enqueue([{ Cmd: CMD_RESULT, State: 0, Text: truncateUtf8(result.text || 'Marked watched', 96) }]);
      fetchData(function () { sendItems(false); });
      return;
    }
    var status = errorToStatus(result);
    enqueue([{ Cmd: CMD_RESULT, State: 1, Text: truncateUtf8(status.text, 96) }]);
    if (status.state === ST_SIGNED_OUT || status.state === ST_NEEDS_PLUGINS || status.state === ST_PERMISSION) {
      sendStatus(status);
    }
  });
}

// Watch messages

function onHello(payload) {
  var wakeup = payload.Reason === 1;
  if (!pluginAvailable()) {
    sendStatus({ state: ST_NEEDS_PLUGINS, text: TEXT_PLUGINS });
    return;
  }
  // The last list at once; the plugin's answer replaces it.
  if (data) {
    sendSchedule(false);
    sendStatus(storedStatus());
    sendItems(wakeup);
  }
  fetchData(function (result) {
    if (result.ok) {
      sendSchedule(true);
      sendStatus(storedStatus());
      sendItems(false);
    }
    requestSync(wakeup ? 'scheduled' : 'open', false);
  });
}

function onSync(payload) {
  var reason = payload.Reason === 1 ? 'manual' : (payload.Reason === 2 ? 'scheduled' : 'open');
  requestSync(reason, reason === 'manual');
}

// The settings page changes things the open watch app shows: the account, the list after a
// sync, the daily sync times. It asks for a refresh after each change.
function onRefresh() {
  if (!pluginAvailable()) {
    sendStatus({ state: ST_NEEDS_PLUGINS, text: TEXT_PLUGINS });
    return;
  }
  fetchData(function (result) {
    if (!result.ok) {
      sendStatus(errorToStatus(result));
      return;
    }
    sendSchedule(true);
    sendStatus(storedStatus());
    sendItems(false);
  });
}

Pebble.addEventListener('configmessage', function (e) {
  if (e.data && e.data.type === 'refresh') {
    onRefresh();
    e.respond({ ok: true });
  } else {
    e.respond({ error: 'unknown message type' });
  }
});

// The watch holds its messages until this arrives (Pebble's "waiting for PebbleKit JS" rule).
Pebble.addEventListener('ready', function () {
  enqueue([{ Cmd: CMD_READY }]);
});

Pebble.addEventListener('appmessage', function (e) {
  var payload = e.payload || {};
  switch (payload.Cmd) {
    case CMD_HELLO:
      onHello(payload);
      break;
    case CMD_SYNC:
      onSync(payload);
      break;
    case CMD_SIGNIN_START:
      if (!pluginAvailable()) {
        sendStatus({ state: ST_NEEDS_PLUGINS, text: TEXT_PLUGINS });
        signinResult(2, TEXT_PLUGINS);
      } else {
        startSignin();
      }
      break;
    case CMD_SIGNIN_STOP:
      stopSignin();
      break;
    case CMD_MARK_WATCHED:
      markWatched(payload);
      break;
    default:
      console.log('Unknown Cmd ' + payload.Cmd);
  }
});
