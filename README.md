# Simkl Timeline

A Pebble app that puts upcoming airings from your [Simkl](https://simkl.com) lists on the Pebble timeline:

- new episodes of the TV shows and anime on your Watching and Plan to Watch lists (On Hold is optional);
- release days of the movies on your Plan to Watch list, in cinemas, digitally, or both, for your country.

Each pin has a **Mark watched** button that records the episode or movie in your Simkl history. The watch app lists what is coming up, and its app glance shows the next airing in the launcher.

## Requirements

- The Pebble app from Core Devices, version 1.18 or later, with plugins turned on (**Settings → Plugins → Plugins / permissions preview**). Simkl Timeline does its work in a plugin, and plugins need that switch.
- A Simkl account.
- Any Pebble: aplite, basalt, chalk, diorite, emery, flint and gabbro builds are included.

## Getting started

1. Install `simkl-timeline.pbw` and allow the permissions it asks for: Internet access to `api.simkl.com` and `data.simkl.in`, and Timeline.
2. Open Simkl Timeline on the watch and choose **Sign in to Simkl**. Scan the QR code with your phone, or go to `simkl.com/pin` and enter the code, then press **Allow**. You can also sign in from the app's settings page in the Pebble app.
3. The first sync runs straight away. After that, the watch syncs once a day by itself (at 06:00 unless you change it), and again whenever you open the app.

The watch's timeline shows the next few days. Pins further ahead reach it as their day comes closer, while the app's own list shows everything in the window you chose.

## Settings

Open the app's settings in the Pebble app.

| Setting | Choices | Default |
| --- | --- | --- |
| What to show | TV shows, Anime, Movies | all three |
| Lists | Watching, Plan to Watch, On Hold (movies always use Plan to Watch) | Watching, Plan to Watch |
| Movie releases | In cinemas, Digital, Both | In cinemas |
| Country | Automatic (the region of your phone's language; the US if the Pebble app doesn't give one) or a country | Automatic |
| Time for release-day pins | any time of day | 09:00 |
| Days ahead | 7, 14, 30 | 14 |
| Reminder | Off, at the start, 5, 15, 30 or 60 minutes before | Off |
| Daily sync | one or two times of day | 06:00 |

## Development

You need the Pebble SDK 4.44 or later, and Node.js with npm: `pebble build` runs `npm install` for the QR code library in `package.json`.

```sh
pebble build                       # all platforms
pebble install --emulator emery    # Pebble Time 2
npm test                           # plugin tests (node --test test/*.test.cjs)
```

See `docs/design.md` for how the parts fit together.

Data from [Simkl](https://simkl.com). Simkl Timeline is not made by Simkl.
