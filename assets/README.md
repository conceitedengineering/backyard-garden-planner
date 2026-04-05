# Asset Drop Folder

Drop your art assets in these folders:

- `assets/plants/` for transparent plant PNGs
- `assets/pavers/` for paver textures or PNG thumbnails

Then update `assets/catalog.json` so each shelf item points at the right image path.

Example item:

```json
{
  "id": "agave-blue",
  "label": "Blue Agave",
  "image": "assets/plants/agave-blue.png",
  "defaultScale": 1.3
}
```

Notes:

- Plant images work best with transparent backgrounds.
- `defaultScale` controls initial size when placed.
- Missing files do not crash the app; a placeholder thumbnail is shown.
