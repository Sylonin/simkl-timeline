// What ends up on the timeline: calendar join, windows, numbering, movie dates, pins, reminders.
const test = require('node:test');
const assert = require('node:assert');
const { createWorld, MIN, HOUR, DAY } = require('./world.cjs');

function ready(settings = {}) {
  const w = createWorld();
  w.signIn();
  w.setSettings(settings);
  return w;
}

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const at = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

test('only titles on the user\'s lists get pins, and the pin carries the episode details', async () => {
  const w = ready();
  w.setItem('shows', 100, 'The Show', 'watching');
  w.setItem('shows', 200, 'Finished Show', 'completed');
  w.tvEpisode(100, 2, 5, '2026-11-12T01:00:00Z', { title: 'The Heist', runtime: 50, network: 'HBO', finale: 2, show: 'The Show' });
  w.tvEpisode(200, 1, 1, '2026-11-12T01:00:00Z');
  w.tvEpisode(300, 1, 1, '2026-11-12T01:00:00Z');
  assert.strictEqual((await w.syncAll('manual')).text, 'done');

  assert.deepStrictEqual(w.pinIds(), ['tv-100-2-5']);
  const pin = w.pin('tv-100-2-5');
  assert.strictEqual(pin.time, '2026-11-12T01:00:00.000Z');
  assert.strictEqual(pin.duration, 50);
  assert.strictEqual(pin.layout.type, 'genericPin');
  assert.strictEqual(pin.layout.title, 'The Show');
  assert.strictEqual(pin.layout.subtitle, 'S2 E5 · Season finale');
  assert.strictEqual(pin.layout.body, 'The Heist\nHBO · 50 min\nsimkl.com/tv/100/show-100');
  assert.strictEqual(pin.layout.tinyIcon, 'system://images/TV_SHOW');
  assert.deepStrictEqual(pin.actions, [{ type: 'pluginAction', title: 'Mark watched', action: 'mark_watched', args: { kind: 'tv', simkl: 100, season: 2, episode: 5 } }]);

  const upcoming = w.store('upcoming');
  assert.strictEqual(upcoming.items.length, 1);
  assert.deepStrictEqual(upcoming.items[0], {
    kind: 'tv', simkl: 100, season: 2, episode: 5, time: Date.parse('2026-11-12T01:00:00Z') / 1000, allDay: false, title: 'The Show', sub: 'S2 E5',
    detail: 'The Heist', network: 'HBO', runtime: 50, finale: 2, release: null, pinId: 'tv-100-2-5',
  });
});

test('Plan to Watch and On Hold follow the settings, and an episode called "Episode 5" is not repeated as its title', async () => {
  const w = ready({ lists: { watching: false, plantowatch: true, hold: true } });
  w.setItem('shows', 1, 'Watching', 'watching');
  w.setItem('shows', 2, 'Planned', 'plantowatch');
  w.setItem('shows', 3, 'Held', 'hold');
  [1, 2, 3].forEach((id) => { w.tvEpisode(id, 1, 5, '2026-11-12T01:00:00Z'); });
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), ['tv-2-1-5', 'tv-3-1-5']);
  assert.strictEqual(w.store('upcoming').items[0].detail, '');
  assert.strictEqual(w.pin('tv-2-1-5').layout.body, 'HBO · 45 min\nsimkl.com/tv/2/show-2');
});

test('the pin window is two days back to the days-ahead setting, and the list from three hours back', async () => {
  const w = ready({ daysAhead: 14 });
  w.setItem('shows', 1, 'Edge', 'watching');
  const eps = {
    1: NOW - 2 * DAY, // in: exactly at the start of the window
    2: NOW - 2 * DAY - 1000, // out
    3: NOW + 14 * DAY, // in: exactly at the end
    4: NOW + 14 * DAY + 1000, // out
    5: NOW - 3 * HOUR, // in the list: exactly three hours back
    6: NOW - 3 * HOUR - 1000, // a pin, but not in the list
  };
  Object.keys(eps).forEach((n) => { w.tvEpisode(1, 1, Number(n), at(eps[n])); });
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), ['tv-1-1-1', 'tv-1-1-3', 'tv-1-1-5', 'tv-1-1-6']);
  assert.deepStrictEqual(w.store('upcoming').items.map((i) => i.episode), [5, 3]);
});

test('seven days ahead is a shorter window than the default', async () => {
  const w = ready({ daysAhead: 7 });
  w.setItem('shows', 1, 'Edge', 'watching');
  w.tvEpisode(1, 1, 1, at(NOW + 7 * DAY));
  w.tvEpisode(1, 1, 2, at(NOW + 7 * DAY + 1000));
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), ['tv-1-1-1']);
});

test('the list holds at most 16 items, the soonest first', async () => {
  const w = ready();
  w.setItem('shows', 1, 'Busy', 'watching');
  for (let n = 1; n <= 20; n++) w.tvEpisode(1, 1, 21 - n, at(NOW + (21 - n) * HOUR));
  await w.syncAll('manual');
  const eps = w.store('upcoming').items.map((i) => i.episode);
  assert.strictEqual(eps.length, 16);
  assert.deepStrictEqual(eps, Array.from({ length: 16 }, (_, i) => i + 1));
  assert.strictEqual(w.pinIds().length, 20);
});

test('anime episodes have no season, specials are season 0, and a film has a day instead of a time', async () => {
  const w = ready({ movieTime: '21:30' });
  w.setItem('anime', 1, 'Long Runner', 'watching');
  w.setItem('anime', 2, 'Has Omake', 'plantowatch');
  w.setItem('anime', 3, 'The Movie', 'plantowatch');
  w.animeEpisode(1, null, 148, '2026-11-11T15:00:00Z', { title: 'Episode 148' });
  w.animeEpisode(2, 0, 6, '2026-11-11T16:15:00Z', { title: 'Omake Shorts 6' });
  // 15:00Z is midnight in Japan, so this film comes out on the 20th.
  w.animeFilm(3, '2026-11-19T15:00:00Z');
  await w.syncAll('manual');

  assert.deepStrictEqual(w.pinIds(), ['an-1-148', 'an-2-0-6', 'an-3-film']);
  assert.strictEqual(w.pin('an-1-148').layout.subtitle, 'E148');
  assert.deepStrictEqual(w.pin('an-1-148').actions[0].args, { kind: 'anime', simkl: 1, episode: 148 });
  assert.strictEqual(w.pin('an-2-0-6').layout.subtitle, 'Special E6');
  assert.deepStrictEqual(w.pin('an-2-0-6').actions[0].args, { kind: 'anime', simkl: 2, season: 0, episode: 6 });
  const film = w.pin('an-3-film');
  assert.strictEqual(film.time, new Date(2026, 10, 20, 21, 30).toISOString());
  assert.strictEqual(film.layout.subtitle, 'Anime film');
  assert.strictEqual(film.duration, undefined);
  assert.deepStrictEqual(film.actions[0].args, { kind: 'anime', simkl: 3 });
  const item = w.store('upcoming').items.find((i) => i.simkl === 3);
  assert.strictEqual(item.allDay, true);
  assert.strictEqual(item.sub, 'Anime film');
});

test('turning a type off removes its pins, even ones that already aired', async () => {
  const w = ready();
  w.setItem('shows', 1, 'Show', 'watching');
  w.setItem('anime', 2, 'Anime', 'watching');
  w.tvEpisode(1, 1, 1, at(NOW - DAY));
  w.tvEpisode(1, 1, 2, at(NOW + DAY));
  w.animeEpisode(2, null, 3, at(NOW + DAY));
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), ['an-2-3', 'tv-1-1-1', 'tv-1-1-2']);

  const saved = await w.config({ type: 'saveSettings', settings: { types: { tv: false } } });
  assert.strictEqual(saved.ok, true);
  assert.deepStrictEqual(w.pinIds(), ['an-2-3']);
  assert.deepStrictEqual(w.store('upcoming').items.map((i) => i.kind), ['anime']);
});

// ---------------------------------------------------------------- movies

async function movieWorld(settings, dates, movie = {}) {
  const w = ready(settings);
  w.setItem('movies', 7, 'The Movie', 'plantowatch', { year: movie.year === undefined ? 2026 : movie.year });
  w.setMovie(7, Object.assign({ title: 'The Movie', dates }, movie));
  const r = await w.syncAll('manual');
  assert.strictEqual(r.text, 'done');
  return w;
}
const localNine = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm).toISOString();

test('cinema: the wide release is chosen over an earlier limited one, and limited alone is used when that is all there is', async () => {
  let w = await movieWorld({ movieRelease: 'cinema' }, { US: [[2, '2026-11-14'], [3, '2026-11-20']] });
  assert.deepStrictEqual(w.pinIds(), ['mv-7-cinema']);
  assert.strictEqual(w.pin('mv-7-cinema').time, localNine(2026, 11, 20));
  assert.strictEqual(w.pin('mv-7-cinema').layout.subtitle, 'In cinemas');
  assert.strictEqual(w.pin('mv-7-cinema').layout.tinyIcon, 'system://images/MOVIE_EVENT');
  assert.strictEqual(w.pin('mv-7-cinema').duration, undefined);

  w = await movieWorld({ movieRelease: 'cinema' }, { US: [[2, '2026-11-14']] });
  assert.strictEqual(w.pin('mv-7-cinema').time, localNine(2026, 11, 14));
});

test('digital ignores cinema, premiere and physical dates; both gives two pins', async () => {
  const dates = { US: [[1, '2026-11-12'], [3, '2026-11-15'], [4, '2026-11-22'], [5, '2026-11-23']] };
  let w = await movieWorld({ movieRelease: 'digital' }, dates);
  assert.deepStrictEqual(w.pinIds(), ['mv-7-digital']);
  assert.strictEqual(w.pin('mv-7-digital').time, localNine(2026, 11, 22));
  assert.strictEqual(w.pin('mv-7-digital').layout.subtitle, 'Digital release');

  w = await movieWorld({ movieRelease: 'both' }, dates);
  assert.deepStrictEqual(w.pinIds(), ['mv-7-cinema', 'mv-7-digital']);
  assert.deepStrictEqual(w.store('upcoming').items.map((i) => i.release), ['cinema', 'digital']);

  w = await movieWorld({ movieRelease: 'cinema' }, { US: [[1, '2026-11-12'], [5, '2026-11-23']] });
  assert.deepStrictEqual(w.pinIds(), []);
});

test('a movie\'s day is pinned at the release time setting, local time', async () => {
  const w = await movieWorld({ movieRelease: 'cinema', movieTime: '18:45' }, { US: [[3, '2026-11-20']] });
  assert.strictEqual(w.pin('mv-7-cinema').time, localNine(2026, 11, 20, 18, 45));
  const item = w.store('upcoming').items[0];
  assert.strictEqual(item.allDay, true);
  assert.strictEqual(item.detail, '2026 · Drama, Comedy');
});

test('the country setting wins; with no date for it the US date is used and the pin says so', async () => {
  const dates = { DE: [[3, '2026-11-22']], US: [[3, '2026-11-20']] };
  let w = await movieWorld({ country: 'DE' }, dates);
  assert.strictEqual(w.pin('mv-7-cinema').time, localNine(2026, 11, 22));
  assert.ok(!w.pin('mv-7-cinema').layout.body.includes('Showing the US date'));

  w = await movieWorld({ country: 'FR' }, dates);
  assert.strictEqual(w.pin('mv-7-cinema').time, localNine(2026, 11, 20));
  assert.ok(w.pin('mv-7-cinema').layout.body.includes('No release date listed for FR. Showing the US date.'));
});

test('the fallback is per kind: a country with only a digital date still takes cinema from the US', async () => {
  const w = await movieWorld({ country: 'DE', movieRelease: 'both' }, { DE: [[4, '2026-11-23']], US: [[3, '2026-11-20'], [4, '2026-11-22']] });
  assert.strictEqual(w.pin('mv-7-cinema').time, localNine(2026, 11, 20));
  assert.ok(w.pin('mv-7-cinema').layout.body.includes('Showing the US date'));
  assert.strictEqual(w.pin('mv-7-digital').time, localNine(2026, 11, 23));
  assert.ok(!w.pin('mv-7-digital').layout.body.includes('Showing the US date'));
});

test('automatic country uses the Pebble locale region, and the US when it is missing or has no region', async () => {
  const dates = { GB: [[3, '2026-11-22']], BR: [[3, '2026-11-23']], US: [[3, '2026-11-20']] };
  const day = async (locale) => {
    const w = createWorld();
    w.locale = locale;
    w.signIn();
    w.setSettings({});
    w.setItem('movies', 7, 'The Movie', 'plantowatch');
    w.setMovie(7, { dates });
    await w.syncAll('manual');
    return w.pin('mv-7-cinema').time;
  };
  assert.strictEqual(await day('en-GB'), localNine(2026, 11, 22));
  assert.strictEqual(await day('pt-BR'), localNine(2026, 11, 23));
  assert.strictEqual(await day('en'), localNine(2026, 11, 20));
  assert.strictEqual(await day(null), localNine(2026, 11, 20));
});

test('only releases inside the window are pinned', async () => {
  const w = await movieWorld({ daysAhead: 7 }, { US: [[3, '2026-11-25']] });
  assert.deepStrictEqual(w.pinIds(), []);
});

test('old movies are not looked up, but one with an unknown year is', async () => {
  const w = ready();
  w.setItem('movies', 1, 'Old', 'plantowatch', { year: 2019 });
  w.setItem('movies', 2, 'Last year', 'plantowatch', { year: 2025 });
  w.setItem('movies', 3, 'Unknown', 'plantowatch', { year: null });
  [1, 2, 3].forEach((id) => { w.setMovie(id, { dates: { US: [[3, '2026-11-20']] } }); });
  await w.syncAll('manual');
  assert.deepStrictEqual(w.paths('api.simkl.com').filter((p) => p.startsWith('GET /movies/')), ['GET /movies/2', 'GET /movies/3']);
});

test('a movie with a date ahead is looked up again after a day, one without after a week', async () => {
  const lookups = async (dates, wait) => {
    const w = await movieWorld({}, dates);
    w.resetCalls();
    w.advance(wait);
    await w.syncAll('scheduled');
    return w.paths('api.simkl.com').filter((p) => p.startsWith('GET /movies/')).length;
  };
  const ahead = { US: [[3, '2026-11-20']] };
  assert.strictEqual(await lookups(ahead, 23 * HOUR), 0);
  assert.strictEqual(await lookups(ahead, 25 * HOUR), 1);
  const past = { US: [[3, '2026-10-01']] };
  assert.strictEqual(await lookups(past, 25 * HOUR), 0);
  assert.strictEqual(await lookups(past, 8 * DAY), 1);
});

test('a movie Simkl does not know is skipped, not retried in a loop', async () => {
  const w = ready();
  w.setItem('movies', 9, 'Ghost', 'plantowatch');
  const r = await w.syncAll('manual');
  assert.strictEqual(r.text, 'done');
  assert.strictEqual(w.paths('api.simkl.com').filter((p) => p === 'GET /movies/9').length, 1);
});

test('at most three movie lookups run at once', async () => {
  const w = ready();
  for (let id = 1; id <= 8; id++) {
    w.setItem('movies', id, 'Movie ' + id, 'plantowatch');
    w.setMovie(id, { dates: { US: [[3, '2026-11-20']] } });
  }
  let inFlight = 0;
  let peak = 0;
  w.hook = async (call) => {
    if (!call.path.startsWith('/movies/')) return undefined;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight--;
    return undefined;
  };
  await w.syncAll('manual');
  assert.strictEqual(peak, 3);
  assert.strictEqual(w.pinIds().length, 8);
});

// ---------------------------------------------------------------- pin identity and updates

async function withEpisode(extra = {}) {
  const w = ready(extra.settings);
  w.setItem('shows', 100, 'The Show', 'watching');
  w.tvEpisode(100, 1, 1, at(NOW + DAY), { title: 'Pilot' });
  await w.syncAll('manual');
  return w;
}

test('an unchanged pin is not inserted again; a changed title updates it under the same id', async () => {
  const w = await withEpisode();
  w.resetCalls();
  w.advance(4 * HOUR);
  await w.syncAll('scheduled');
  assert.deepStrictEqual(w.phone.ops, []);

  w.sim.cdn.tv.calendar[0].episode.title = 'The Pilot';
  w.advance(4 * HOUR);
  await w.syncAll('scheduled');
  assert.deepStrictEqual(w.phone.ops, [{ op: 'insert', id: 'tv-100-1-1' }]);
  assert.ok(w.pin('tv-100-1-1').layout.body.startsWith('The Pilot'));
});

test('a pin that is deleted and later wanted again comes back under a new id, since the phone ignores the old one', async () => {
  const w = await withEpisode();
  const entry = w.sim.cdn.tv.calendar[0];
  const meta = w.sim.cdn.tv.metadata[100];
  for (const [round, id] of [[1, 'tv-100-1-1-2'], [2, 'tv-100-1-1-3']]) {
    w.sim.cdn.tv.calendar = [];
    w.advance(4 * HOUR);
    await w.syncAll('scheduled');
    assert.deepStrictEqual(w.pinIds(), [], 'round ' + round + ': deleted while the episode left the schedule');
    w.sim.cdn.tv.calendar = [entry];
    w.sim.cdn.tv.metadata[100] = meta;
    w.advance(4 * HOUR);
    await w.syncAll('scheduled');
    assert.deepStrictEqual(w.pinIds(), [id]);
  }
  assert.strictEqual(w.store('pins')['tv-100-1-1'].deleted, true);
  assert.strictEqual(w.store('upcoming').items[0].pinId, 'tv-100-1-1-3');
});

test('a title that left the lists loses its pin even when the episode already aired', async () => {
  const w = ready();
  w.setItem('shows', 100, 'The Show', 'watching');
  w.tvEpisode(100, 1, 1, at(NOW - DAY));
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), ['tv-100-1-1']);
  w.setItem('shows', 100, 'The Show', 'completed');
  w.advance(2 * MIN);
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), []);
});

test('an episode that drops out of the schedule keeps its pin once it has aired, and loses it while still ahead', async () => {
  const w = ready();
  w.setItem('shows', 100, 'The Show', 'watching');
  w.tvEpisode(100, 1, 1, at(NOW - DAY)); // aired
  w.tvEpisode(100, 1, 2, at(NOW + DAY)); // ahead
  await w.syncAll('manual');
  assert.deepStrictEqual(w.pinIds(), ['tv-100-1-1', 'tv-100-1-2']);
  w.sim.cdn.tv.calendar = [];
  w.advance(4 * HOUR);
  await w.syncAll('scheduled');
  assert.deepStrictEqual(w.pinIds(), ['tv-100-1-1']);
});

test('pin records are forgotten four days after the pin time, and not before', async () => {
  const w = ready();
  w.setItem('shows', 100, 'The Show', 'watching');
  w.tvEpisode(100, 1, 1, at(NOW - DAY));
  await w.syncAll('manual');
  w.sim.cdn.tv.calendar = [];
  w.advance(3 * DAY);
  await w.syncAll('scheduled');
  assert.ok(w.store('pins')['tv-100-1-1'], 'three days after the episode is within the four days');
  w.advance(2 * DAY);
  await w.syncAll('scheduled');
  assert.strictEqual(w.store('pins')['tv-100-1-1'], undefined);
});

// ---------------------------------------------------------------- reminders

test('the reminder comes the chosen minutes before an episode, at the pin time for a movie, and not at all when off', async () => {
  let w = await withEpisode({ settings: { reminder: 15 } });
  let pin = w.pin('tv-100-1-1');
  assert.strictEqual(pin.reminders.length, 1);
  assert.strictEqual(pin.reminders[0].time, new Date(NOW + DAY - 15 * MIN).toISOString());
  assert.deepStrictEqual(pin.reminders[0].layout, { type: 'genericReminder', title: 'Show 100: S1 E1', tinyIcon: 'system://images/TV_SHOW' });

  w = await withEpisode({ settings: { reminder: 0 } });
  assert.strictEqual(w.pin('tv-100-1-1').reminders[0].time, new Date(NOW + DAY).toISOString());

  w = await withEpisode({ settings: { reminder: -1 } });
  assert.strictEqual(w.pin('tv-100-1-1').reminders, undefined);

  w = await movieWorld({ reminder: 60 }, { US: [[3, '2026-11-20']] });
  pin = w.pin('mv-7-cinema');
  assert.strictEqual(pin.reminders[0].time, pin.time);
  assert.strictEqual(pin.reminders[0].layout.title, 'The Movie: In cinemas');
});

test('changing the reminder setting updates existing pins', async () => {
  const w = await withEpisode({ settings: { reminder: -1 } });
  assert.strictEqual(w.pin('tv-100-1-1').reminders, undefined);
  await w.config({ type: 'saveSettings', settings: { reminder: 30 } });
  assert.strictEqual(w.pin('tv-100-1-1').reminders[0].time, new Date(NOW + DAY - 30 * MIN).toISOString());
});

// ---------------------------------------------------------------- mark watched

async function marked(setup, args) {
  const w = ready({ movieRelease: 'both' });
  setup(w);
  await w.syncAll('manual');
  const before = w.pinIds();
  const r = await w.action('mark_watched', args);
  return { w, r, before };
}

test('marking a TV episode watched sends season and episode, removes the pin and the list entry, and it stays gone', async () => {
  const { w, r, before } = await marked((x) => {
    x.setItem('shows', 100, 'The Show', 'watching');
    x.tvEpisode(100, 2, 5, at(NOW + DAY));
    x.tvEpisode(100, 2, 6, at(NOW + 2 * DAY));
  }, { kind: 'tv', simkl: 100, season: 2, episode: 5 });
  assert.deepStrictEqual(before, ['tv-100-2-5', 'tv-100-2-6']);
  assert.deepStrictEqual(r, { ok: true, text: 'Marked watched' });
  assert.deepStrictEqual(w.sim.history, [{ shows: [{ ids: { simkl: 100 }, seasons: [{ number: 2, episodes: [{ number: 5 }] }] }] }]);
  assert.deepStrictEqual(w.pinIds(), ['tv-100-2-6']);
  assert.deepStrictEqual(w.store('upcoming').items.map((i) => i.episode), [6]);

  w.advance(4 * HOUR);
  await w.syncAll('scheduled');
  assert.deepStrictEqual(w.pinIds(), ['tv-100-2-6'], 'the calendar still lists it, but the user watched it');
  assert.deepStrictEqual(w.store('upcoming').items.map((i) => i.episode), [6]);
});

test('anime episodes are marked in the flat numbering, with no season of their own', async () => {
  const { w, r } = await marked((x) => {
    x.setItem('anime', 1, 'Long Runner', 'watching');
    x.animeEpisode(1, null, 148, at(NOW + DAY));
  }, { kind: 'anime', simkl: 1, episode: 148 });
  assert.strictEqual(r.text, 'Marked watched');
  assert.deepStrictEqual(w.sim.history, [{ shows: [{ ids: { simkl: 1 }, seasons: [{ number: 1, episodes: [{ number: 148 }] }] }] }]);
  assert.deepStrictEqual(w.pinIds(), []);
});

test('an anime special is season 0', async () => {
  const { w } = await marked((x) => {
    x.setItem('anime', 1, 'Has Omake', 'watching');
    x.animeEpisode(1, 0, 6, at(NOW + DAY));
  }, { kind: 'anime', simkl: 1, season: 0, episode: 6 });
  assert.deepStrictEqual(w.sim.history, [{ shows: [{ ids: { simkl: 1 }, seasons: [{ number: 0, episodes: [{ number: 6 }] }] }] }]);
  assert.deepStrictEqual(w.pinIds(), []);
});

test('marking a movie watched removes both its cinema and digital pins; an anime film is sent whole, under shows', async () => {
  let { w, before } = await marked((x) => {
    x.setItem('movies', 7, 'The Movie', 'plantowatch');
    x.setMovie(7, { dates: { US: [[3, '2026-11-20'], [4, '2026-11-22']] } });
  }, { kind: 'movie', simkl: 7 });
  assert.deepStrictEqual(before, ['mv-7-cinema', 'mv-7-digital']);
  assert.deepStrictEqual(w.sim.history, [{ movies: [{ ids: { simkl: 7 } }] }]);
  assert.deepStrictEqual(w.pinIds(), []);

  ({ w } = await marked((x) => {
    x.setItem('anime', 3, 'The Movie', 'plantowatch');
    x.animeFilm(3, '2026-11-19T15:00:00Z');
  }, { kind: 'anime', simkl: 3 }));
  assert.deepStrictEqual(w.sim.history, [{ shows: [{ ids: { simkl: 3 } }] }]);
  assert.deepStrictEqual(w.pinIds(), []);
});

test('when Simkl cannot find the episode, nothing is removed and the user is told', async () => {
  const w = ready();
  w.setItem('shows', 100, 'The Show', 'watching');
  w.tvEpisode(100, 1, 1, at(NOW + DAY));
  await w.syncAll('manual');
  w.hook = (call) => (call.path === '/sync/history' ? w.response(201, { added: {}, not_found: { episodes: [{ number: 1 }] } }) : undefined);
  const r = await w.action('mark_watched', { kind: 'tv', simkl: 100, season: 1, episode: 1 });
  assert.strictEqual(r.error.code, 'UNKNOWN');
  assert.deepStrictEqual(w.pinIds(), ['tv-100-1-1']);
});

test('a TV episode needs a season and an episode', async () => {
  const w = ready();
  const r = await w.action('mark_watched', { kind: 'tv', simkl: 100 });
  assert.strictEqual(r.error.code, 'INVALID_ARGS');
  assert.strictEqual(w.calls.length, 0);
});
