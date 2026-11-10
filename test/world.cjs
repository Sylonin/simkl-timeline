// A fake phone and a fake Simkl for the plugin tests.
//
// Every action and config message boots the plugin script in a fresh vm context, the way the Pebble
// app does, so anything the plugin keeps in a variable instead of storage is lost between calls.
// What persists is only what the real app persists: localStorage, secure storage, the timeline.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');
const CLIENT_ID = '0c2ba84016dd0ef96cb51b3dd5d77eaff1597be12102c28f089e08e3c846235e';
const API = 'api.simkl.com';
const CDN = 'data.simkl.in';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const plain = (value) => JSON.parse(JSON.stringify(value));

function createWorld() {
  const clock = { now: Date.UTC(2026, 10, 10, 12, 0, 0) };
  const FakeDate = class extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() { return clock.now; }
  };
  const secure = new Map();
  const world = {
    clock,
    secure,
    calls: [],
    secureReads: [],
    waits: [], // the waits the plugin asked its caller for, in ms
    latency: 0, // ms each request takes
    permissions: {},
    pinApi: true,
    permissionApi: true,
    locale: null, // 'en-GB'; null = preferences/units unavailable
    phone: { pins: new Map(), deleted: new Set(), ops: [] },
    hook: null, // async (call) => response | Error | undefined, to break things on purpose
    onInsert: null, // async (pin) => void, runs while the phone takes an insert: a second invocation can act meanwhile
    onWait: null, // (ms) => void, runs while the caller waits: what another invocation does meanwhile
  };

  // ---------------------------------------------------------------- Simkl
  let stamp = 0;
  const nextStamp = () => new Date(Date.UTC(2026, 10, 10, 0, 0, ++stamp)).toISOString().replace('.000Z', 'Z');
  const sim = {
    user: { name: 'syl' },
    validAccess: new Set(['at1']),
    refreshToken: 'rt1',
    nextAccess: 'at2',
    tokenScope: 'media:read media:write',
    activities: { all: nextStamp(), tv_shows: {}, anime: {}, movies: {} },
    rows: { shows: [], anime: [], movies: [] },
    cdn: {
      tv: { calendar: [], metadata: {} },
      anime: { calendar: [], metadata: {} },
    },
    movies: {},
    device: { code: 'dev-secret-1', user: 'ABCD-EFGH', interval: 5, expires: 900, approved: false, answer: null },
    history: [],
  };
  world.sim = sim;
  const BLOCK = { shows: 'tv_shows', anime: 'anime', movies: 'movies' };

  world.touch = (type, bucket) => {
    const s = nextStamp();
    sim.activities[BLOCK[type]][bucket] = s;
    sim.activities[BLOCK[type]].all = s;
    sim.activities.all = s;
    return s;
  };
  world.setItem = (type, id, title, status, extra = {}) => {
    const t = world.touch(type, status);
    const media = { title, year: extra.year === undefined ? 2026 : extra.year, ids: { simkl: id, slug: extra.slug || 'slug-' + id } };
    const row = { status, _t: t, added_to_watchlist_at: t };
    row[type === 'movies' ? 'movie' : 'show'] = media;
    sim.rows[type] = sim.rows[type].filter((r) => (r.show || r.movie).ids.simkl !== id).concat([row]);
  };
  world.removeItem = (type, id) => {
    sim.rows[type] = sim.rows[type].filter((r) => (r.show || r.movie).ids.simkl !== id);
    world.touch(type, 'removed_from_list');
  };
  world.tvEpisode = (id, season, episode, iso, extra = {}) => {
    sim.cdn.tv.calendar.push({
      simkl_id: id, date: iso, finale_type: extra.finale || null,
      episode: { season, episode, title: extra.title === undefined ? 'Episode ' + episode : extra.title, runtime: extra.runtime === undefined ? 45 : extra.runtime, url: 'x' },
    });
    sim.cdn.tv.metadata[id] = { title: extra.show || 'Show ' + id, network: extra.network === undefined ? 'HBO' : extra.network, ids: { simkl_id: id, slug: 'show-' + id } };
  };
  world.animeEpisode = (id, season, episode, iso, extra = {}) => {
    const ep = { episode, title: extra.title || 'Episode ' + episode, runtime: 24, url: 'x' };
    if (season !== null) ep.season = season;
    sim.cdn.anime.calendar.push({ simkl_id: id, date: iso, finale_type: null, episode: ep });
    sim.cdn.anime.metadata[id] = { title: extra.show || 'Anime ' + id, ids: { simkl_id: id, slug: 'anime-' + id } };
  };
  world.animeFilm = (id, iso, title = 'Anime film ' + id) => {
    sim.cdn.anime.calendar.push({ simkl_id: id, date: iso, finale_type: null });
    sim.cdn.anime.metadata[id] = { title, ids: { simkl_id: id, slug: 'film-' + id } };
  };
  world.clearCalendar = (kind) => { sim.cdn[kind].calendar = []; };
  // The file's Last-Modified follows its content, as a regenerated file's would.
  world.lastModified = (kind) => {
    const text = JSON.stringify(sim.cdn[kind]);
    let sum = 0;
    for (let i = 0; i < text.length; i++) sum = (sum * 31 + text.charCodeAt(i)) % 1000000;
    return new Date(Date.UTC(2026, 10, 10, 6, 0, 0) + sum * 1000).toUTCString();
  };
  world.setMovie = (id, o = {}) => {
    sim.movies[id] = {
      title: o.title || 'Movie ' + id, year: o.year === undefined ? 2026 : o.year, runtime: o.runtime === undefined ? 120 : o.runtime,
      genres: o.genres || ['Drama', 'Comedy', 'Horror'], ids: { simkl: id, slug: 'movie-' + id },
      release_dates: Object.keys(o.dates || {}).map((cc) => ({ iso_3166_1: cc, results: o.dates[cc].map(([type, date]) => ({ type, release_date: date })) })),
    };
  };

  function response(status, json, headers = {}) {
    const text = json === undefined ? '' : JSON.stringify(json);
    return { status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => text };
  }

  function route(call) {
    const auth = (call.headers.Authorization || '').replace('Bearer ', '');
    const needsAuth = call.host === API && (call.path.startsWith('/sync/') || call.path === '/users/settings');
    if (needsAuth && !sim.validAccess.has(auth)) return response(401, { error: 'invalid_token', code: 401 });
    if (call.host === CDN) {
      const kind = call.path.endsWith('/tv.json') ? 'tv' : 'anime';
      const file = sim.cdn[kind];
      const lastModified = world.lastModified(kind);
      if (call.headers['If-Modified-Since'] === lastModified) return response(304);
      return response(200, { calendar: file.calendar, metadata: file.metadata }, { 'last-modified': lastModified });
    }
    const p = call.path;
    if (p === '/sync/activities') return response(200, plain(sim.activities));
    if (p.startsWith('/sync/all-items')) {
      const parts = p.split('/').filter(Boolean); // sync, all-items, type?, status?
      const strip = (r) => { const { _t, ...rest } = r; return rest; };
      if (call.query.extended === 'simkl_ids_only') {
        const out = {};
        for (const t of Object.keys(sim.rows)) out[t] = sim.rows[t].map((r) => ({ [r.show ? 'show' : 'movie']: { ids: { simkl: (r.show || r.movie).ids.simkl } } }));
        return response(200, out);
      }
      const types = parts[2] ? [parts[2]] : Object.keys(sim.rows);
      const out = {};
      for (const t of types) {
        out[t] = sim.rows[t]
          .filter((r) => (parts[3] ? r.status === parts[3] : true))
          .filter((r) => (call.query.date_from ? r._t > call.query.date_from : true))
          .map(strip);
      }
      return response(200, out);
    }
    if (p === '/users/settings') return response(200, { user: { name: sim.user.name }, account: { id: 1 } });
    if (p === '/sync/history') {
      sim.history.push(call.body);
      return response(201, { added: { movies: 1, shows: 1, episodes: 1 }, not_found: { movies: [], shows: [], episodes: [] } });
    }
    if (p.startsWith('/movies/')) {
      const m = sim.movies[p.split('/')[2]];
      return m ? response(200, m) : response(404, { error: 'not_found' });
    }
    if (p === '/oauth2/device') {
      return response(200, {
        device_code: sim.device.code, user_code: sim.device.user, verification_uri: 'https://simkl.com/pin',
        verification_uri_complete: 'https://simkl.com/pin?user_code=' + sim.device.user, expires_in: sim.device.expires, interval: sim.device.interval,
      });
    }
    if (p === '/oauth2/token') {
      if (call.form.grant_type === 'refresh_token') {
        if (call.form.refresh_token !== sim.refreshToken) return response(400, { error: 'invalid_grant' });
        sim.validAccess.add(sim.nextAccess);
        return response(200, { access_token: sim.nextAccess, refresh_token: sim.refreshToken, expires_in: 604800, scope: sim.tokenScope });
      }
      if (sim.device.answer) return response(sim.device.answer.status, sim.device.answer.json);
      if (sim.device.approved) {
        sim.validAccess.add('at1');
        return response(200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 604800, scope: sim.tokenScope });
      }
      return response(400, { error: 'authorization_pending' });
    }
    if (p === '/oauth2/revoke') return response(200, {});
    return response(404, { error: 'unknown route ' + p });
  }

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const headers = Object.assign({}, init.headers);
    const call = { method: init.method || 'GET', host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), headers, body: init.body, at: clock.now };
    if (init.body && headers['Content-Type'] === 'application/json') call.body = JSON.parse(init.body);
    if (init.body && headers['Content-Type'] === 'application/x-www-form-urlencoded') call.form = Object.fromEntries(new URLSearchParams(init.body));
    world.calls.push(call);
    clock.now += world.latency;
    if (world.hook) {
      const hooked = await world.hook(call);
      if (hooked instanceof Error) throw hooked;
      if (hooked) return hooked;
    }
    return route(call);
  }
  world.response = response;

  // ---------------------------------------------------------------- phone
  function Pebble() {
    const handlers = {};
    const api = {
      registerActionHandler: (h) => { handlers.action = h; },
      registerConfigHandler: (h) => { handlers.config = h; },
      secureStorage: {
        getItem: async (k) => { world.secureReads.push(k); return secure.has(k) ? secure.get(k) : null; },
        setItem: async (k, v) => { secure.set(k, String(v)); },
        removeItem: async (k) => { secure.delete(k); },
      },
    };
    if (world.permissionApi) api.permissions = { query: async (name) => world.permissions[name] || 'granted' };
    if (world.locale) {
      api.readSource = async () => ({ instances: [{ properties: { locale: { shortText: { text: world.locale } } } }] });
    }
    if (world.pinApi) {
      api.insertTimelinePin = async (pin) => {
        if (world.onInsert) await world.onInsert(pin);
        world.phone.ops.push({ op: 'insert', id: pin.id });
        // The real app ignores an insert under an id that was deleted.
        if (!world.phone.deleted.has(pin.id)) world.phone.pins.set(pin.id, plain(pin));
      };
      api.deleteTimelinePin = async (id) => {
        world.phone.ops.push({ op: 'delete', id });
        world.phone.pins.delete(id);
        world.phone.deleted.add(id);
      };
    }
    return { api, handlers };
  }

  function boot() {
    const { api, handlers } = Pebble();
    const context = {
      console: { log() {}, error() {} },
      fetch,
      Pebble: api,
      Date: FakeDate,
    };
    // The Pebble app's plugin engine has no timers and no browser globals; it throws like this.
    ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'navigator', 'window', 'self', 'document', 'location'].forEach((key) => {
      Object.defineProperty(context, key, { get() { throw new Error(key + ' is not available to plugins'); }, configurable: true });
    });
    // The engine has localStorage, but on Android PKJS overwrites it with its own stale copy.
    Object.defineProperty(context, 'localStorage', { get() { throw new Error('localStorage is shared with PKJS; keep plugin state in Pebble.secureStorage'); } });
    vm.createContext(context);
    vm.runInContext(SOURCE, context);
    return handlers;
  }

  async function invoke(handler, message, makeRespond) {
    return new Promise((resolve, reject) => {
      let answered = false;
      const done = (value) => { answered = true; resolve(value); };
      handler(message, makeRespond(done)).then(() => { if (!answered) reject(new Error('handler finished without answering')); }, reject);
    });
  }

  world.action = (action, args = {}) => invoke(boot().action, { action, args }, (done) => ({
    ok: (value) => done({ ok: true, text: value.text }),
    error: (code, message) => done({ error: { code, message } }),
  }));
  world.config = (message) => invoke(boot().config, message, (done) => (value) => done(plain(value)));

  // ---------------------------------------------------------------- helpers for tests
  world.advance = (ms) => { clock.now += ms; };
  world.signIn = (extra = {}) => {
    secure.set('tokens', JSON.stringify(Object.assign({ access: 'at1', refresh: 'rt1', expiresAt: clock.now + 7 * DAY, scope: 'media:read media:write' }, extra)));
    secure.set('account', JSON.stringify({ name: 'syl' }));
  };
  world.store = (key) => (secure.has(key) ? JSON.parse(secure.get(key)) : null);
  world.setStore = (key, value) => secure.set(key, JSON.stringify(value));
  world.setSettings = (patch) => {
    const base = { types: { tv: true, anime: true, movies: true }, lists: { watching: true, plantowatch: true, hold: false }, movieRelease: 'cinema', country: '', movieTime: '09:00', daysAhead: 14, reminder: -1, syncTimes: [360, -1] };
    const merged = Object.assign({}, base, patch);
    world.setStore('settings', merged);
  };
  world.callsTo = (host) => world.calls.filter((c) => c.host === host);
  world.paths = (host) => world.callsTo(host).map((c) => c.method + ' ' + c.path);
  world.resetCalls = () => { world.calls.length = 0; world.phone.ops.length = 0; world.waits.length = 0; world.secureReads.length = 0; };
  // Runs sync calls until the plugin says done, like PKJS does: again at once on 'more', and
  // after the wait on 'wait:<ms>'.
  world.syncAll = async (reason) => {
    for (let i = 0; i < 20; i++) {
      const r = await world.action('sync', { reason });
      if (r.error) return r;
      if (r.text === 'done') return r;
      const wait = /^wait:(\d+)$/.exec(r.text);
      if (wait) {
        const ms = Number(wait[1]);
        world.waits.push(ms);
        clock.now += ms;
        if (world.onWait) world.onWait(ms);
      } else if (r.text !== 'more') {
        throw new Error('unexpected sync answer ' + r.text);
      }
    }
    throw new Error('sync never finished');
  };
  world.iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  world.pin = (id) => world.phone.pins.get(id);
  world.pinIds = () => [...world.phone.pins.keys()].sort();
  return world;
}

module.exports = { createWorld, plain, CLIENT_ID, API, CDN, MIN, HOUR, DAY };
