# RunTrack

A Strava-style run tracker that runs entirely in the browser. No build step and no backend: open `index.html` from any static web server.

## Features

- **Live GPS recording**: map with your route drawn as you go, distance, time, average and current pace, pause/resume, and the screen kept awake. An unsaved run is recovered after a reload. There's also a *Simulate GPS* option for trying it on a desktop.
- **Activity feed** with route thumbnails and a weekly goal progress bar.
- **Activity detail**: route map with start/finish markers, per-km or per-mile splits, an elevation profile, best efforts (400m to marathon) with PR badges, notes, editing, and GPX export.
- **Add / Import**: import GPX files from a watch or another app (several at once), or enter a run by hand.
- **Profile**: weekly distance chart for the last 12 weeks against your goal, week/month/year/all-time totals, and personal records.
- **Settings**: km or miles, name, weekly goal, JSON backup/restore, and sample data.

## Running it

GPS needs a secure context, so serve it over HTTPS (or `localhost`):

```
cd runtrack
python3 -m http.server 8000
# open http://localhost:8000
```

To record a real run on a phone, host the folder on any HTTPS static host (for example GitHub Pages).

## Notes

- Data lives in `localStorage` for this browser only. There are no accounts, followers or kudos, since those need a server.
- Map tiles come from OpenStreetMap and Leaflet loads from cdnjs, so the maps need a network connection.
- Phone browsers may stop GPS updates when the screen is off or the tab is in the background. Keep the page open while recording.
