## BIM IFC Viewer (browser)

This folder contains a simple web app to:

- Load an `.ifc` file in the browser and view it in 3D (orbit/zoom/pan)
- Click an element to highlight it and display its data
- Filter/isolate by **storey (floor)** via a dropdown

### Run it locally

```bash
cd bim-viewer
npm install
npm run dev
```

Then open the URL printed by Vite.
**Don’t open `index.html` directly** (IFC loading uses WASM + a module web worker and needs an HTTP server).

### Load your IFC

- **Option A (recommended):** click **“Open IFC…”** and choose your `.ifc`
- **Option B:** put a file at `bim-viewer/public/sample.ifc` and click **“Load sample.ifc”**

### Notes

- The WebIFC WASM (`public/web-ifc.wasm`) is copied automatically on install via a `postinstall` script.
- DWG is not handled in this starter (typical approach is: IFC for 3D + convert DWG to web-friendly 2D).

