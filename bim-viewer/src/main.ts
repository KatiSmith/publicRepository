import './style.css';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as FRAGS from '@thatopen/fragments';

const baseURL = import.meta.env.BASE_URL || '/';
const wasmDir = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;

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
const clearSelectionBtn = document.querySelector<HTMLButtonElement>('#clearSelection')!;
const propsEl = document.querySelector<HTMLPreElement>('#props')!;

const components = new OBC.Components();

const worlds = components.get(OBC.Worlds);
const world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>();
world.scene = new OBC.SimpleScene(components);
world.renderer = new OBC.SimpleRenderer(components, viewport, { antialias: true });
world.camera = new OBC.SimpleCamera(components);

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
  wasm: { path: wasmDir, absolute: false },
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

function setProps(value: unknown) {
  propsEl.textContent = JSON.stringify(value, null, 2);
}

async function clearIFCFromScene() {
  if (currentModel) {
    try {
      world.scene.three.remove(currentModel.object);
      await currentModel.dispose();
    } catch {
      // ignore
    }
  }

  currentModel = null;
  storeys = [];
  storeySelect.innerHTML = `<option value="all">All</option>`;
  storeySelect.disabled = true;
  clearSelectionBtn.disabled = true;
  await fragments.resetHighlight();
  await hider.set(true);
  setProps({});
}

function escapeHtml(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function runDiagnostics() {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const started = now();

  const checks: Record<string, unknown> = {
    baseURL,
    wasmDir,
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
  setProps({
    status: 'Loading…',
    file: name,
    sizeBytes: buffer.byteLength,
    sizeMB: Math.round((buffer.byteLength / (1024 * 1024)) * 100) / 100,
  });

  try {
    await clearIFCFromScene();

    const bytes = new Uint8Array(buffer);
    const model = await ifcLoader.load(bytes, true, name);
    currentModel = model;
    world.scene.three.add(model.object);

    await classifier.byIfcBuildingStorey({ classificationName: 'Storeys' });

    const groups = classifier.list.get('Storeys');
    const options: StoreyOption[] = [];
    if (groups) {
      for (const [groupName, groupData] of groups.entries()) {
        options.push({ name: groupName, map: await groupData.get() });
      }
    }
    options.sort((a, b) => a.name.localeCompare(b.name));
    storeys = options;

    storeySelect.innerHTML =
      `<option value="all">All</option>` +
      storeys.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
    storeySelect.disabled = false;
    clearSelectionBtn.disabled = false;

    // Frame model
    const box = new THREE.Box3().setFromObject(model.object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.2;
    world.camera.controls.setLookAt(
      center.x + dist,
      center.y + dist * 0.75,
      center.z + dist,
      center.x,
      center.y,
      center.z,
      true,
    );

    setProps({ status: 'Loaded', file: name, storeys: storeys.map((s) => s.name) });
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
      relationsDefault: { attributes: true, relations: true },
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

loadSampleBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/sample.ifc');
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
