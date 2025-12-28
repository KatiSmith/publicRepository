import './style.css';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as FRAGS from '@thatopen/fragments';

const baseURL = import.meta.env.BASE_URL || '/';
const wasmDir = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
const wasmDirAbs = new URL(wasmDir, window.location.href).href;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <div class="layout">
    <header class="topbar">
      <div class="title">BIM IFC Viewer</div>
      <div class="controls">
        <label class="file">
          <input id="ifcFile" type="file" accept=".ifc" />
          <span>Open IFC…</span>
        </label>
        <button id="loadSample" type="button">Load sample.ifc</button>
        <button id="diagnostics" type="button">Diagnostics</button>
        <button id="showAll" type="button" disabled>Show all</button>
        <button id="fitView" type="button" disabled>Fit view</button>
        <label class="label">
          Floor:
          <select id="storeySelect" disabled>
            <option value="all">All</option>
          </select>
        </label>
        <button id="clearSelection" type="button" disabled>Clear selection</button>
      </div>
    </header>
    <main class="main">
      <section class="viewport">
        <div id="viewport"></div>
        <div class="hint">Left click: select • Right click: pan • Wheel: zoom</div>
      </section>
      <aside class="sidebar">
        <div class="panel">
          <div class="panelTitle">Selected element</div>
          <pre id="props">{}</pre>
        </div>
      </aside>
    </main>
  </div>
`;

const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const fileInput = document.querySelector<HTMLInputElement>('#ifcFile')!;
const storeySelect = document.querySelector<HTMLSelectElement>('#storeySelect')!;
const loadSampleBtn = document.querySelector<HTMLButtonElement>('#loadSample')!;
const diagnosticsBtn = document.querySelector<HTMLButtonElement>('#diagnostics')!;
const showAllBtn = document.querySelector<HTMLButtonElement>('#showAll')!;
const fitViewBtn = document.querySelector<HTMLButtonElement>('#fitView')!;
const clearSelectionBtn = document.querySelector<HTMLButtonElement>('#clearSelection')!;
const propsEl = document.querySelector<HTMLPreElement>('#props')!;

const components = new OBC.Components();

const worlds = components.get(OBC.Worlds);
const world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>();
world.scene = new OBC.SimpleScene(components);
world.renderer = new OBC.SimpleRenderer(components, viewport, { antialias: true });
world.camera = new OBC.SimpleCamera(components);
world.renderer.mode = OBC.RendererMode.AUTO;

components.init();
world.scene.setup();

world.scene.three.background = new THREE.Color(0x0b1220);
world.scene.three.add(new THREE.AmbientLight(0xffffff, 0.65));
const dir = new THREE.DirectionalLight(0xffffff, 0.85);
dir.position.set(10, 20, 10);
world.scene.three.add(dir);

components.get(OBC.Grids).create(world);
world.camera.controls.setLookAt(12, 10, 12, 0, 1.5, 0);

const fragments = components.get(OBC.FragmentsManager);
const fragmentsWorkerURL = new URL('@thatopen/fragments/dist/Worker/worker.mjs', import.meta.url).href;
fragments.init(fragmentsWorkerURL);

const hider = components.get(OBC.Hider);
const classifier = components.get(OBC.Classifier);

const ifcLoader = components.get(OBC.IfcLoader);
await ifcLoader.setup({
  autoSetWasm: false,
  // IMPORTANT: web-ifc expects a DIRECTORY, and will request `${path}/web-ifc.wasm`.
  // Use Vite's base URL so it also works when hosted under a sub-path.
  wasm: { path: wasmDirAbs, absolute: true },
});

let currentModel: FRAGS.FragmentsModel | null = null;
type StoreyOption = { name: string; map: OBC.ModelIdMap };
let storeys: StoreyOption[] = [];

const pointer = new THREE.Vector2();
const selectionStyle: FRAGS.MaterialDefinition = {
  color: new THREE.Color(0xffd54a),
  renderedFaces: FRAGS.RenderedFaces.TWO,
  opacity: 0.65,
  transparent: true,
  depthTest: false,
  customId: 'selection',
};

function safeStringify(value: unknown, space = 2, maxChars = 200_000) {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'bigint') return val.toString();
      return val;
    },
    space,
  );
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}\n…(truncated, ${json.length} chars total)…`;
}

function setProps(value: unknown) {
  propsEl.textContent = safeStringify(value, 2);
}

function msSince(startedAtMs: number) {
  return Math.round((performance.now() - startedAtMs) * 10) / 10;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let t: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = window.setTimeout(() => reject(new Error(`Timed out after ${ms}ms at step: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (t !== undefined) window.clearTimeout(t);
  }
}

async function clearIFCFromScene() {
  // IMPORTANT: cleanup must never block the next load.
  // Some operations (disposing models / resetting highlight) can take time or hang
  // depending on browser/worker state. We do best-effort and move on.

  const model = currentModel;
  currentModel = null;

  if (model) {
    try {
      world.scene.three.remove(model.object);
    } catch {
      // ignore
    }

    // Dispose in background (do not await).
    void model.dispose().catch(() => {
      // ignore
    });
  }

  storeys = [];
  storeySelect.innerHTML = `<option value="all">All</option>`;
  storeySelect.disabled = true;
  clearSelectionBtn.disabled = true;
  showAllBtn.disabled = true;
  fitViewBtn.disabled = true;

  // Best-effort background resets (do not await).
  void fragments.resetHighlight().catch(() => {
    // ignore
  });
  void hider.set(true).catch(() => {
    // ignore
  });
}

function escapeHtml(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fitViewToBBox(box: THREE.Box3) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = Math.max(1, maxDim * 1.2);
  world.camera.controls.setLookAt(
    center.x + dist,
    center.y + dist * 0.75,
    center.z + dist,
    center.x,
    center.y,
    center.z,
    true,
  );
}

function computeModelBBox(object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object);
  return box;
}

function disableFrustumCulling(object: THREE.Object3D) {
  object.traverse((o) => {
    (o as any).frustumCulled = false;
  });
}

function updateCameraClippingFromBBox(box: THREE.Box3) {
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const cam = world.camera.three;
  cam.near = Math.max(0.01, maxDim / 10_000);
  cam.far = Math.max(10_000, maxDim * 50);
  cam.updateProjectionMatrix();
}

function sniffHeaderText(buffer: ArrayBuffer, maxBytes = 512) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, maxBytes));
  // IFC is ASCII-compatible at the header; decode without throwing.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function looksLikeIFC(buffer: ArrayBuffer) {
  const header = sniffHeaderText(buffer).trimStart();
  // Most IFC files start with ISO-10303-21; also allow common STEP headers.
  return header.startsWith('ISO-10303-21') || header.includes('FILE_SCHEMA') || header.includes('DATA;');
}

function looksLikeHTML(buffer: ArrayBuffer) {
  const header = sniffHeaderText(buffer).toLowerCase();
  return header.includes('<!doctype html') || header.includes('<html') || header.includes('<head');
}

async function runDiagnostics() {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const started = now();

  const checks: Record<string, unknown> = {
    baseURL,
    wasmDir,
    wasmDirAbs,
    fragmentsWorkerURL,
    userAgent: navigator.userAgent,
  };

  const fetchCheck = async (label: string, url: string) => {
    const t0 = now();
    try {
      const res = await fetch(url, { cache: 'no-store' });
      checks[label] = { ok: res.ok, status: res.status, ms: Math.round(now() - t0), url };
    } catch (e) {
      checks[label] = { ok: false, error: String(e), ms: Math.round(now() - t0), url };
    }
  };

  // These 2 files must be reachable for IFC loading to work.
  await fetchCheck('fetch:web-ifc.wasm', `${wasmDir}web-ifc.wasm`);
  await fetchCheck('fetch:fragments-worker', fragmentsWorkerURL);

  checks.totalMs = Math.round(now() - started);
  setProps({ diagnostics: checks });
}

async function loadIFCFromArrayBuffer(buffer: ArrayBuffer, name = 'model.ifc') {
  const startedAt = performance.now();
  setProps({
    status: 'Loading…',
    file: name,
    sizeBytes: buffer.byteLength,
    sizeMB: Math.round((buffer.byteLength / (1024 * 1024)) * 100) / 100,
    step: 'start',
  });

  try {
    setProps({ status: 'Loading…', file: name, step: 'clear previous', tMs: msSince(startedAt) });
    // Non-blocking cleanup (never fail the load)
    try {
      await withTimeout(clearIFCFromScene(), 2_000, 'clear previous model');
    } catch (e) {
      setProps({
        status: 'Loading…',
        file: name,
        step: 'clear previous (skipped)',
        warning: String(e),
        tMs: msSince(startedAt),
      });
    }

    if (buffer.byteLength < 1024 && looksLikeHTML(buffer)) {
      throw new Error(
        `The loaded file "${name}" looks like HTML, not IFC. If you clicked “Load sample.ifc”, you probably don't have a real sample at public/sample.ifc.`,
      );
    }
    if (!looksLikeIFC(buffer)) {
      // Not always fatal (some files have odd headers), but it's a very strong signal.
      setProps({
        status: 'Loading…',
        file: name,
        warning:
          'This file does not look like a standard IFC header (ISO-10303-21). If it fails, share the file header and error.',
      });
    }

    setProps({ status: 'Loading…', file: name, step: 'ifcLoader.load (parse + convert)', tMs: msSince(startedAt) });
    const bytes = new Uint8Array(buffer);
    const model = await withTimeout(ifcLoader.load(bytes, true, name), 120_000, 'ifcLoader.load');
    currentModel = model;
    world.scene.three.add(model.object);
    // Improve "partial model" issues (streaming/culling).
    model.getClippingPlanesEvent = () => world.renderer!.three.clippingPlanes ?? [];
    model.graphicsQuality = 1;
    disableFrustumCulling(model.object);

    // Ensure the fragments LOD/culling system isn't hiding anything important.
    model.useCamera(world.camera.three);
    await withTimeout(model.setLodMode(FRAGS.LodMode.ALL_VISIBLE), 30_000, 'model.setLodMode(ALL_VISIBLE)');

    // Force the fragments engine to finish pending geometry/material requests,
    // otherwise the model can appear "empty" and the bounding box is invalid.
    setProps({ status: 'Loading…', file: name, step: 'fragments.core.update(true)', tMs: msSince(startedAt) });
    await withTimeout(fragments.core.update(true), 120_000, 'fragments.core.update(true)');

    // Ensure nothing is hidden by default.
    setProps({ status: 'Loading…', file: name, step: 'show all', tMs: msSince(startedAt) });
    await withTimeout(hider.set(true), 30_000, 'hider.set(true)');

    setProps({ status: 'Loading…', file: name, step: 'classify storeys', tMs: msSince(startedAt) });
    await classifier.byIfcBuildingStorey({ classificationName: 'Storeys' });

    const groups = classifier.list.get('Storeys');
    const options: StoreyOption[] = [];
    if (groups) {
      for (const [groupName, groupData] of groups.entries()) {
        options.push({
          name: groupName,
          map: await withTimeout(groupData.get(), 30_000, `classifier groupData.get (${groupName})`),
        });
      }
    }
    options.sort((a, b) => a.name.localeCompare(b.name));
    storeys = options;

    storeySelect.innerHTML =
      `<option value="all">All</option>` +
      storeys.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
    storeySelect.disabled = false;
    clearSelectionBtn.disabled = false;
    showAllBtn.disabled = false;
    fitViewBtn.disabled = false;

    // Frame model
    const box = computeModelBBox(model.object);
    if (box.isEmpty()) {
      const childCount = model.object.children.length;
      throw new Error(
        `Model loaded but produced an empty bounding box (children: ${childCount}). This usually means geometry didn't generate or is filtered out.`,
      );
    }
    updateCameraClippingFromBBox(box);
    fitViewToBBox(box);
    // After moving the camera, force another update in case geometry loads by view.
    await withTimeout(fragments.core.update(true), 60_000, 'fragments.core.update(true) after fit');

    setProps({
      status: 'Loaded',
      file: name,
      storeys: storeys.map((s) => s.name),
      bbox: {
        min: box.min.toArray(),
        max: box.max.toArray(),
      },
      totalMs: Math.round(msSince(startedAt)),
    });
  } catch (e) {
    setProps({
      status: 'Load failed',
      file: name,
      error: String(e),
      hint:
        'Click “Diagnostics” and share the output. Missing web-ifc.wasm / worker files are the most common causes.',
    });
    throw e;
  }
}

async function pick(event: PointerEvent) {
  if (!currentModel) return;

  const canvas = world.renderer!.three.domElement;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);

  const hit = await fragments.raycast({
    camera: world.camera.three,
    mouse: pointer,
    dom: canvas,
  });

  if (!hit) return;

  const map: OBC.ModelIdMap = { [hit.fragments.modelId]: new Set([hit.localId]) };
  await fragments.highlight(selectionStyle, map);

  try {
    const data = await fragments.getData(map, {
      attributesDefault: true,
      // Relations can be cyclic (Decomposes <-> IsDecomposedBy). Keep selection data safe/light.
      relationsDefault: { attributes: false, relations: false },
    });
    setProps({ modelId: hit.fragments.modelId, localId: hit.localId, data: data[hit.fragments.modelId]?.[0] ?? null });
  } catch (e) {
    setProps({ modelId: hit.fragments.modelId, localId: hit.localId, error: String(e) });
  }
}

world.renderer!.three.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  pick(e);
});

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    await loadIFCFromArrayBuffer(await f.arrayBuffer(), f.name);
  } catch {
    // error is already shown in the UI
  }
});

diagnosticsBtn.addEventListener('click', () => {
  runDiagnostics().catch((e) => setProps({ diagnosticsError: String(e) }));
});

showAllBtn.addEventListener('click', () => {
  hider
    .set(true)
    .then(async () => {
      if (currentModel) {
        currentModel.useCamera(world.camera.three);
        await currentModel.setLodMode(FRAGS.LodMode.ALL_VISIBLE);
      }
      await fragments.core.update(true);
    })
    .then(() => setProps({ status: 'Showing all' }))
    .catch((e) => setProps({ error: String(e) }));
});

fitViewBtn.addEventListener('click', () => {
  if (!currentModel) return;
  const box = computeModelBBox(currentModel.object);
  if (box.isEmpty()) {
    setProps({ error: 'Cannot fit view: model bounding box is empty.' });
    return;
  }
  fitViewToBBox(box);
  setProps({
    status: 'Fit view',
    bbox: { min: box.min.toArray(), max: box.max.toArray() },
  });
});

loadSampleBtn.addEventListener('click', async () => {
  try {
    const sampleURL = new URL(`${baseURL.replace(/\/+$/, '')}/sample.ifc`, window.location.href).href;
    const res = await fetch(sampleURL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`sample.ifc not found (HTTP ${res.status}). Put one in bim-viewer/public/sample.ifc`);
    await loadIFCFromArrayBuffer(await res.arrayBuffer(), 'sample.ifc');
  } catch (e) {
    setProps({ error: String(e) });
  }
});

storeySelect.addEventListener('change', async () => {
  const v = storeySelect.value;
  if (v === 'all') {
    await hider.set(true);
  } else {
    const storey = storeys.find((s) => s.name === v);
    if (!storey) return;
    await hider.isolate(storey.map);
  }
});

clearSelectionBtn.addEventListener('click', () => {
  fragments.resetHighlight().then(() => setProps({})).catch(() => setProps({}));
});

// Run once on startup so failures are immediately visible.
runDiagnostics().catch(() => {
  // ignore
});

// Extra visibility into IFC load lifecycle
ifcLoader.onIfcStartedLoading.add(() => {
  setProps({ status: 'Loading…', step: 'IfcLoader: started loading' });
});
ifcLoader.onIfcImporterInitialized.add(() => {
  setProps({ status: 'Loading…', step: 'IfcLoader: importer initialized' });
});
