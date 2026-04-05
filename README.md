# Backyard Garden Planner MVP

Small 3D planning tool for laying out plants and pavers on a grid with a blocked no-go zone.

## Run

Serve this folder with any static server, then open it in a browser.

Examples:

- `npx serve .`
- `python -m http.server 5173`

Then open `http://localhost:5173`.

## Asset Workflow

1. Drop your PNGs into:
   - `assets/plants/`
   - `assets/pavers/`
2. Update `assets/catalog.json` with your item list.
3. Refresh the browser.

## Current MVP Features

- Isometric orthographic camera over a 3D grid
- Yard boundary and blocked no-go zones
- Shelf for plant and paver items
- Click-to-place on snapped grid
- Drag to move items
- Scale selected item
- Paver occupancy blocking
