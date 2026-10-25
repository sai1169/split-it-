# RunTrack

A Strava-style run tracker that runs entirely in the browser. No build step and no backend: open `index.html` from any static web server.

## Features

- **Live GPS recording**: map with your route drawn as you go, distance, time, average and current pace, pause/resume, and the screen kept awake. An unsaved run is recovered after a reload. There's also a *Simulate GPS* option for trying it on a desktop.
- **Activity feed** with route thumbnails and a weekly goal progress bar.
- **Activity detail**: route map with start/finish markers, per-km or per-mile splits, an elevation profile, best efforts (400m to marathon) with PR badges, notes, editing, and GPX export.
- **Add / Import**: import GPX files from a watch or another app (several at once), or enter a run by hand.
- **Profile**: weekly distance chart for the last 12 weeks against your goal, week/month/year/all-time totals, and personal records.
- **Settings**: km or miles, name, weekly goal, voice updates, JSON backup/restore, and sample data.

## On your phone

RunTrack is an installable app (a PWA):

- **Install**: Android/Chrome shows an *Install* banner. On iPhone, open it in Safari, tap Share, then **Add to Home Screen**. It then opens full screen with its own icon.
- **Works offline**: the app is cached after the first visit. Map areas you've already viewed stay available offline.
- **Run screen**: a full-screen map with a bottom sheet, large stats and big round Start / Pause / Finish buttons. The tab bar hides during a run.
- **Voice updates** at every km or mile (distance, time, average pace, last split), plus vibration on start, pause and each split.
- **Screen lock** (🔒) blocks pocket taps. Press and hold to unlock.
- **Screen stays awake** while recording, and the wake lock is taken back after you switch apps.

## Running it

GPS needs a secure context, so serve it over HTTPS (or `localhost`):

```
cd runtrack
python3 -m http.server 8000
# open http://localhost:8000
```

To use it on a phone, host the folder on any HTTPS static host. With GitHub Pages: in the repo, go to Settings → Pages, deploy from your branch, then open `https://<user>.github.io/<repo>/runtrack/` on your phone and install it.

## Notes

- Data lives in `localStorage` for this browser only. There are no accounts, followers or kudos, since those need a server.
- Map tiles come from OpenStreetMap and Leaflet loads from cdnjs, so the maps need a network connection.
- Web apps can't record GPS with the screen off. iOS in particular pauses location in the background. RunTrack keeps the screen awake and offers the screen lock instead, so keep it in the foreground during a run. True background tracking needs a native wrapper such as Capacitor.
