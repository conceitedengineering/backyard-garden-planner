import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const FIGMA_SCALE = 0.06;
const FIGMA_YARD_WIDTH = 1436.5;
const FIGMA_YARD_HEIGHT = 614.878;
const GRID_SUBDIVISIONS = 20;

function figmaToWorld(point) {
  const [x, y] = point;
  return [
    (x - FIGMA_YARD_WIDTH / 2) * FIGMA_SCALE,
    (y - FIGMA_YARD_HEIGHT / 2) * FIGMA_SCALE,
  ];
}

const yardPolygon = [
  figmaToWorld([0, FIGMA_YARD_HEIGHT]),
  figmaToWorld([FIGMA_YARD_WIDTH, FIGMA_YARD_HEIGHT]),
  figmaToWorld([1084, 0]),
  figmaToWorld([352, 0]),
];

const rawNoGoPolygon = [
  figmaToWorld([658, -1]),
  figmaToWorld([1088, -1]),
  figmaToWorld([1201.5, 203.5]),
  figmaToWorld([1086, 203.5]),
  figmaToWorld([1026, 73]),
  figmaToWorld([658, 73]),
];

const noGoPolygons = [alignNoGoCornerToYardTopRight(rawNoGoPolygon, yardPolygon)];

const yardBounds = getPolygonBounds(yardPolygon);
const GRID_STEP = (yardBounds.maxX - yardBounds.minX) / GRID_SUBDIVISIONS;

const catalogFallback = {
  plants: [],
  pavers: [],
};

const state = {
  catalog: catalogFallback,
  activeTool: null,
  selectedId: null,
  objects: new Map(),
  meshById: new Map(),
  paverCells: new Set(),
  paverCellMeshes: new Map(),
  hoveredCellKey: null,
  hoveredCellMesh: null,
  paintMode: null,
  nextId: 1,
  drag: null,
  cameraViewSize: 0,
};

const canvas = document.getElementById("viewport");
const plantsShelf = document.getElementById("plantsShelf");
const scaleRange = document.getElementById("scaleRange");
const deleteButton = document.getElementById("deleteButton");
const clearButton = document.getElementById("clearButton");
const statusText = document.getElementById("statusText");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#e6e6e6");

const camera = new THREE.OrthographicCamera();
const controls = new OrbitControls(camera, canvas);
controls.enableRotate = false;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.minZoom = 0.8;
controls.maxZoom = 3.2;
controls.zoomSpeed = 0.9;

const ambient = new THREE.AmbientLight("#ffffff", 1.1);
const sun = new THREE.DirectionalLight("#fff6df", 1.0);
sun.position.set(24, 40, 18);
scene.add(ambient, sun);

const insideGrid = createPerspectiveGridInTrapezoid(
  yardPolygon,
  GRID_SUBDIVISIONS,
  GRID_SUBDIVISIONS,
  "#757b70",
  0.008,
);
insideGrid.renderOrder = 1;
scene.add(insideGrid);

drawPolygonLine(yardPolygon, "#111111", 0.05);
for (const poly of noGoPolygons) {
  const noGoMesh = makeFlatPolygon(poly, "#181818", 0.03, 0.9);
  noGoMesh.renderOrder = 4;
  scene.add(noGoMesh);
}

configureCameraForYard();
setCameraProjection();

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const scratchPoint = new THREE.Vector3();
const textureLoader = new THREE.TextureLoader();

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);
canvas.addEventListener("pointerleave", () => clearHoveredCell());
window.addEventListener("resize", onResize);

scaleRange.addEventListener("input", () => {
  if (!state.selectedId) {
    return;
  }
  const object = state.objects.get(state.selectedId);
  if (!object) {
    return;
  }
  object.scale = Number(scaleRange.value);
  applyScale(object);
});

deleteButton.addEventListener("click", () => {
  if (!state.selectedId) {
    setStatus("Nothing selected.", false);
    return;
  }
  removeObject(state.selectedId);
  setSelected(null);
  setStatus("Deleted selected object.", false);
});

clearButton.addEventListener("click", () => {
  clearEntireCanvas();
  setStatus("Canvas cleared.", false);
});

await loadCatalog();
renderShelf();
setStatus("Ready. Choose a plant or paver, then click inside the yard to place.", false);
animate();

function configureCameraForYard() {
  const bounds = getPolygonBounds(yardPolygon);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const span = Math.max(width, depth);
  state.cameraViewSize = span * 1.04;

  camera.position.set(centerX, 120, centerZ);
  camera.up.set(0, 0, -1);
  const target = new THREE.Vector3(centerX, 0, centerZ - depth * 0.42);
  camera.lookAt(target);
  controls.target.copy(target);
  controls.update();
}

function setCameraProjection() {
  const width = Math.max(canvas.clientWidth, 1);
  const height = Math.max(canvas.clientHeight, 1);
  const aspect = width / height;
  const viewSize = state.cameraViewSize || 48;
  camera.left = (-viewSize * aspect) / 2;
  camera.right = (viewSize * aspect) / 2;
  camera.top = viewSize / 2;
  camera.bottom = -viewSize / 2;
  camera.near = 0.1;
  camera.far = 500;
  camera.updateProjectionMatrix();
}

function onResize() {
  renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);
  setCameraProjection();
}

function toGroundPoint(event) {
  const rect = canvas.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const didHitGround = raycaster.ray.intersectPlane(groundPlane, scratchPoint);
  if (!didHitGround) {
    return null;
  }
  return scratchPoint.clone();
}

function onPointerDown(event) {
  const point = toGroundPoint(event);
  if (!point) {
    return;
  }

  const hits = pickPlacedObjects(event);
  const hit = hits[0];
  if (hit) {
    const id = hit.object.userData.id;
    const object = state.objects.get(id);
    if (!object) {
      return;
    }
    setSelected(id);
    state.drag = {
      pointerId: event.pointerId,
      id,
      offsetX: object.position.x - point.x,
      offsetZ: object.position.z - point.z,
    };
    canvas.setPointerCapture(event.pointerId);
    controls.enabled = false;
    setStatus(`Dragging "${object.label}"`, false);
    return;
  }

  if (!state.activeTool) {
    const cell = worldPointToCell(point);
    if (!cell || !canToggleCell(cell)) {
      setSelected(null);
      return;
    }
    beginCellPaint(cell, event.pointerId);
    return;
  }

  const snapped = snapToGrid(point);
  const validation = validatePlacement(snapped.x, snapped.z, state.activeTool.type, null);
  if (!validation.ok) {
    setStatus(validation.message, true);
    return;
  }
  placeObject(state.activeTool, snapped.x, snapped.z);
}

function onPointerMove(event) {
  const point = toGroundPoint(event);
  if (!point) {
    clearHoveredCell();
    return;
  }

  if (state.drag && state.drag.pointerId === event.pointerId) {
    const object = state.objects.get(state.drag.id);
    if (!object) {
      return;
    }

    const desiredX = point.x + state.drag.offsetX;
    const desiredZ = point.z + state.drag.offsetZ;
    const snapped = snapToGrid({ x: desiredX, z: desiredZ });
    const validation = validatePlacement(snapped.x, snapped.z, object.type, object.id);
    if (!validation.ok) {
      return;
    }

    object.position.x = snapped.x;
    object.position.z = snapped.z;
    applyTransform(object);
    return;
  }

  if (state.activeTool?.type === "plant") {
    clearHoveredCell();
    return;
  }
  if (state.paintMode && state.paintMode.pointerId === event.pointerId) {
    const cell = worldPointToCell(point);
    if (cell && canToggleCell(cell)) {
      setPaverCellFilled(cell, state.paintMode.action === "fill");
      state.paintMode.lastCellKey = getCellKey(cell);
    }
  } else {
    updateHoveredCell(point);
  }
}

function onPointerUp(event) {
  if (state.paintMode && state.paintMode.pointerId === event.pointerId) {
    state.paintMode = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    return;
  }
  if (!state.drag || state.drag.pointerId !== event.pointerId) {
    return;
  }
  const object = state.objects.get(state.drag.id);
  controls.enabled = true;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
  state.drag = null;
  if (object) {
    setStatus(`Moved "${object.label}"`, false);
  }
}

function pickPlacedObjects(event) {
  const rect = canvas.getBoundingClientRect();
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  return raycaster
    .intersectObjects(Array.from(state.meshById.values()), true)
    .sort((a, b) => a.distance - b.distance);
}

function worldPointToCell(point) {
  if (!pointInPolygon([point.x, point.z], yardPolygon)) {
    return null;
  }
  const topLeft = yardPolygon[3];
  const topRight = yardPolygon[2];
  const bottomLeft = yardPolygon[0];
  const bottomRight = yardPolygon[1];

  const topZ = topLeft[1];
  const bottomZ = bottomLeft[1];
  const zSpan = bottomZ - topZ;
  if (Math.abs(zSpan) < 1e-6) {
    return null;
  }

  const v = (point.z - topZ) / zSpan;
  if (v < 0 || v > 1) {
    return null;
  }

  const left = lerp2(topLeft, bottomLeft, v);
  const right = lerp2(topRight, bottomRight, v);
  const xSpan = right[0] - left[0];
  if (Math.abs(xSpan) < 1e-6) {
    return null;
  }

  const u = (point.x - left[0]) / xSpan;
  if (u < 0 || u > 1) {
    return null;
  }

  const col = Math.min(GRID_SUBDIVISIONS - 1, Math.max(0, Math.floor(u * GRID_SUBDIVISIONS)));
  const row = Math.min(GRID_SUBDIVISIONS - 1, Math.max(0, Math.floor(v * GRID_SUBDIVISIONS)));
  return { col, row };
}

function getCellKey(cell) {
  return `${cell.col},${cell.row}`;
}

function getCellPolygon(cell) {
  const u0 = cell.col / GRID_SUBDIVISIONS;
  const u1 = (cell.col + 1) / GRID_SUBDIVISIONS;
  const v0 = cell.row / GRID_SUBDIVISIONS;
  const v1 = (cell.row + 1) / GRID_SUBDIVISIONS;
  const topLeft = yardPolygon[3];
  const topRight = yardPolygon[2];
  const bottomLeft = yardPolygon[0];
  const bottomRight = yardPolygon[1];
  const p00 = lerp2(lerp2(topLeft, bottomLeft, v0), lerp2(topRight, bottomRight, v0), u0);
  const p10 = lerp2(lerp2(topLeft, bottomLeft, v0), lerp2(topRight, bottomRight, v0), u1);
  const p11 = lerp2(lerp2(topLeft, bottomLeft, v1), lerp2(topRight, bottomRight, v1), u1);
  const p01 = lerp2(lerp2(topLeft, bottomLeft, v1), lerp2(topRight, bottomRight, v1), u0);
  return [p01, p11, p10, p00];
}

function canToggleCell(cell) {
  const polygon = getCellPolygon(cell);
  const center = polygon.reduce(
    (acc, point) => {
      acc.x += point[0];
      acc.z += point[1];
      return acc;
    },
    { x: 0, z: 0 },
  );
  center.x /= polygon.length;
  center.z /= polygon.length;

  if (!pointInPolygon([center.x, center.z], yardPolygon)) {
    return false;
  }
  for (const noGoPolygon of noGoPolygons) {
    if (pointInPolygon([center.x, center.z], noGoPolygon)) {
      return false;
    }
  }
  return true;
}

function updateHoveredCell(point) {
  const cell = worldPointToCell(point);
  if (!cell || !canToggleCell(cell)) {
    clearHoveredCell();
    return;
  }
  const key = getCellKey(cell);
  if (state.hoveredCellKey === key) {
    return;
  }
  clearHoveredCell();

  const polygon = getCellPolygon(cell);
  const mesh = makeFlatPolygon(polygon, "#b8b8b2", 0.024, 0.62);
  mesh.renderOrder = 6;
  scene.add(mesh);

  state.hoveredCellKey = key;
  state.hoveredCellMesh = mesh;
}

function clearHoveredCell() {
  if (!state.hoveredCellMesh) {
    state.hoveredCellKey = null;
    return;
  }
  scene.remove(state.hoveredCellMesh);
  state.hoveredCellMesh = null;
  state.hoveredCellKey = null;
}

function togglePaverCell(cell) {
  const key = getCellKey(cell);
  if (state.paverCells.has(key)) {
    state.paverCells.delete(key);
    const mesh = state.paverCellMeshes.get(key);
    if (mesh) {
      scene.remove(mesh);
      state.paverCellMeshes.delete(key);
    }
    return;
  }

  const polygon = getCellPolygon(cell);
  const inset = insetPolygon(polygon, 0.18);
  const mesh = makeFlatPolygon(inset, "#666861", 0.026, 0.9);
  mesh.renderOrder = 7;
  scene.add(mesh);
  state.paverCells.add(key);
  state.paverCellMeshes.set(key, mesh);
}

function beginCellPaint(cell, pointerId) {
  const key = getCellKey(cell);
  const shouldFill = !state.paverCells.has(key);
  state.paintMode = {
    pointerId,
    action: shouldFill ? "fill" : "erase",
    lastCellKey: key,
  };
  setPaverCellFilled(cell, shouldFill);
  canvas.setPointerCapture(pointerId);
}

function setPaverCellFilled(cell, filled) {
  const key = getCellKey(cell);
  if (filled) {
    if (state.paverCells.has(key)) {
      return;
    }
    const polygon = getCellPolygon(cell);
    const inset = insetPolygon(polygon, 0.18);
    const mesh = makeFlatPolygon(inset, "#666861", 0.026, 0.9);
    mesh.renderOrder = 7;
    scene.add(mesh);
    state.paverCells.add(key);
    state.paverCellMeshes.set(key, mesh);
    return;
  }
  if (!state.paverCells.has(key)) {
    return;
  }
  state.paverCells.delete(key);
  const mesh = state.paverCellMeshes.get(key);
  if (mesh) {
    scene.remove(mesh);
  }
  state.paverCellMeshes.delete(key);
}

function clearEntireCanvas() {
  for (const id of Array.from(state.objects.keys())) {
    removeObject(id);
  }
  state.selectedId = null;
  scaleRange.value = "1";

  for (const mesh of state.paverCellMeshes.values()) {
    scene.remove(mesh);
  }
  state.paverCells.clear();
  state.paverCellMeshes.clear();

  clearHoveredCell();
  state.paintMode = null;
  state.activeTool = null;
  refreshShelfActiveState();
}

function insetPolygon(points, amount) {
  const center = points.reduce(
    (acc, point) => {
      acc.x += point[0];
      acc.z += point[1];
      return acc;
    },
    { x: 0, z: 0 },
  );
  center.x /= points.length;
  center.z /= points.length;

  return points.map(([x, z]) => [
    x + (center.x - x) * amount,
    z + (center.z - z) * amount,
  ]);
}

function placeObject(tool, x, z) {
  const id = `obj-${state.nextId++}`;
  const mesh = tool.type === "plant" ? makePlantMesh(tool.item) : makePaverMesh(tool.item);
  mesh.userData.id = id;
  mesh.userData.type = tool.type;
  scene.add(mesh);

  const object = {
    id,
    type: tool.type,
    label: tool.item.label,
    itemId: tool.item.id,
    mesh,
    position: new THREE.Vector3(x, tool.type === "paver" ? 0.07 : 0.12, z),
    scale: Number(tool.item.defaultScale ?? 1),
    rotationY: 0,
    aspect: 1,
  };

  state.objects.set(id, object);
  state.meshById.set(id, mesh);
  mesh.userData.ownerId = id;

  if (tool.type === "plant") {
    loadSpriteTexture(tool.item.image, mesh, object);
  } else {
    loadPaverTexture(tool.item.image, mesh);
  }

  applyTransform(object);
  applyScale(object);
  setSelected(id);
  setStatus(`Placed "${object.label}"`, false);
}

function loadSpriteTexture(url, sprite, object) {
  if (!url) {
    return;
  }
  textureLoader.load(
    url,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      sprite.material.map = texture;
      sprite.material.color = new THREE.Color("#ffffff");
      sprite.material.needsUpdate = true;
      const image = texture.image;
      if (image && image.width && image.height) {
        object.aspect = image.width / image.height;
      }
      applyScale(object);
    },
    undefined,
    () => {
      sprite.material.color = new THREE.Color("#7ea963");
    },
  );
}

function loadPaverTexture(url, mesh) {
  if (!url) {
    return;
  }
  textureLoader.load(
    url,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      mesh.material.map = texture;
      mesh.material.color = new THREE.Color("#ffffff");
      mesh.material.needsUpdate = true;
    },
    undefined,
    () => {},
  );
}

function makePlantMesh() {
  const material = new THREE.SpriteMaterial({
    color: "#7ea963",
    transparent: true,
    alphaTest: 0.15,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 20;
  return sprite;
}

function makePaverMesh() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({
      color: "#b8b5ab",
      roughness: 0.96,
      metalness: 0,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.DoubleSide,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 12;
  return mesh;
}

function removeObject(id) {
  const object = state.objects.get(id);
  if (!object) {
    return;
  }
  scene.remove(object.mesh);
  state.meshById.delete(id);
  state.objects.delete(id);
}

function setSelected(id) {
  state.selectedId = id;
  for (const [objectId, object] of state.objects) {
    const selected = objectId === id;
    if (object.type === "paver") {
      object.mesh.material.emissive = new THREE.Color(selected ? "#4f5c28" : "#000000");
      object.mesh.material.emissiveIntensity = selected ? 0.45 : 0;
    } else {
      object.mesh.material.color = new THREE.Color(selected ? "#d8f4c7" : "#ffffff");
    }
  }
  if (!id) {
    scaleRange.value = "1";
    return;
  }
  const object = state.objects.get(id);
  if (object) {
    scaleRange.value = String(object.scale);
  }
}

function applyTransform(object) {
  object.mesh.position.copy(object.position);
  object.mesh.rotation.y = object.rotationY;
}

function applyScale(object) {
  if (object.type === "plant") {
    const baseHeight = 3.2;
    const s = object.scale;
    const width = Math.max(0.45, baseHeight * object.aspect) * s;
    const height = baseHeight * s;
    object.mesh.scale.set(width, height, 1);
  } else {
    const s = object.scale;
    object.mesh.scale.set(s, s, 1);
  }
}

function snapToGrid(point) {
  return {
    x: Math.round(point.x / GRID_STEP) * GRID_STEP,
    z: Math.round(point.z / GRID_STEP) * GRID_STEP,
  };
}

function validatePlacement(x, z, type, movingId) {
  if (!pointInPolygon([x, z], yardPolygon)) {
    return { ok: false, message: "Cannot place outside the backyard boundary." };
  }
  for (const noGoPolygon of noGoPolygons) {
    if (pointInPolygon([x, z], noGoPolygon)) {
      return { ok: false, message: "Blocked zone: that area is unavailable." };
    }
  }
  if (type === "paver") {
    for (const object of state.objects.values()) {
      if (object.type !== "paver" || object.id === movingId) {
        continue;
      }
      if (Math.abs(object.position.x - x) < 0.1 && Math.abs(object.position.z - z) < 0.1) {
        return { ok: false, message: "That paver cell is already occupied." };
      }
    }
  }
  return { ok: true };
}

function makeFlatPolygon(points, color, y, opacity) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], -points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    shape.lineTo(points[i][0], -points[i][1]);
  }
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

function drawPolygonLine(points, color, y) {
  const coords = points.map(([x, z]) => new THREE.Vector3(x, y, z));
  coords.push(new THREE.Vector3(points[0][0], y, points[0][1]));
  const geometry = new THREE.BufferGeometry().setFromPoints(coords);
  const material = new THREE.LineBasicMaterial({ color });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
}

function createPerspectiveGridInTrapezoid(polygon, cols, rows, color, y) {
  const bottomLeft = polygon[0];
  const bottomRight = polygon[1];
  const topRight = polygon[2];
  const topLeft = polygon[3];
  const points = [];

  // Family 1: depth-like lines linking top and bottom edges.
  for (let i = 0; i <= cols; i += 1) {
    const t = i / cols;
    const a = lerp2(topLeft, topRight, t);
    const b = lerp2(bottomLeft, bottomRight, t);
    points.push(new THREE.Vector3(a[0], y, a[1]));
    points.push(new THREE.Vector3(b[0], y, b[1]));
  }

  // Family 2: width-like lines linking left and right edges.
  for (let j = 0; j <= rows; j += 1) {
    const t = j / rows;
    const a = lerp2(topLeft, bottomLeft, t);
    const b = lerp2(topRight, bottomRight, t);
    points.push(new THREE.Vector3(a[0], y, a[1]));
    points.push(new THREE.Vector3(b[0], y, b[1]));
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.66,
    depthWrite: false,
  });
  return new THREE.LineSegments(geometry, material);
}

function lerp2(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function alignNoGoCornerToYardTopRight(noGoPolygon, yardPolygonRef) {
  const noGoTopRightCorner = noGoPolygon[1];
  const yardTopRightCorner = yardPolygonRef[2];
  const dx = yardTopRightCorner[0] - noGoTopRightCorner[0];
  const dz = yardTopRightCorner[1] - noGoTopRightCorner[1];
  return noGoPolygon.map(([x, z]) => [x + dx, z + dz]);
}

function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function getPolygonBounds(polygon) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of polygon) {
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

async function loadCatalog() {
  const configuredCatalog = await loadCatalogJson();
  const discoveredPlants = await discoverAssetEntries("assets/plants/", "plant", configuredCatalog.plants);
  const discoveredPavers = await discoverAssetEntries("assets/pavers/", "paver", configuredCatalog.pavers);

  state.catalog = {
    plants: discoveredPlants.length > 0 ? discoveredPlants : configuredCatalog.plants,
    pavers: discoveredPavers.length > 0 ? discoveredPavers : configuredCatalog.pavers,
  };

  if (state.catalog.plants.length === 0 && state.catalog.pavers.length === 0) {
    setStatus("No assets found yet. Drop PNGs into assets/plants and assets/pavers.", true);
    return;
  }

  setStatus(
    `Loaded ${state.catalog.plants.length} plants and ${state.catalog.pavers.length} pavers.`,
    false,
  );
}

async function loadCatalogJson() {
  try {
    const response = await fetch("assets/catalog.json", { cache: "no-store" });
    if (!response.ok) {
      return { plants: [], pavers: [] };
    }
    const catalog = await response.json();
    return {
      plants: Array.isArray(catalog.plants) ? catalog.plants : [],
      pavers: Array.isArray(catalog.pavers) ? catalog.pavers : [],
    };
  } catch {
    return { plants: [], pavers: [] };
  }
}

async function discoverAssetEntries(directoryPath, type, configuredEntries) {
  let fileNames = [];
  try {
    fileNames = await listFilesFromDirectory(directoryPath);
  } catch {
    return configuredEntries;
  }

  const configuredByName = new Map(
    configuredEntries.map((item) => [normalizeKey(item.label || item.id || item.image || ""), item]),
  );
  const discovered = fileNames
    .filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name))
    .map((name) => {
      const bare = name.replace(/\.[^.]+$/, "");
      const key = normalizeKey(bare);
      const configured = configuredByName.get(key);
      const encodedName = encodeURIComponent(name).replace(/%2F/g, "/");
      return {
        id: configured?.id || `${type}-${key}`,
        label: configured?.label || toTitleCase(bare),
        image: `${directoryPath}${encodedName}`,
        defaultScale: Number(configured?.defaultScale ?? (type === "plant" ? 1.2 : 1)),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return discovered;
}

async function listFilesFromDirectory(directoryPath) {
  const response = await fetch(directoryPath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Directory fetch failed: ${directoryPath}`);
  }
  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const anchors = Array.from(doc.querySelectorAll("a[href]"));
  const names = [];

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href || href === "../" || href.endsWith("/")) {
      continue;
    }
    const cleanHref = href.split("?")[0].split("#")[0];
    const fileName = decodeURIComponent(cleanHref);
    if (fileName === ".gitkeep") {
      continue;
    }
    names.push(fileName);
  }
  return names;
}

function normalizeKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function toTitleCase(value) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderShelf() {
  plantsShelf.innerHTML = "";

  for (const item of state.catalog.plants) {
    plantsShelf.appendChild(makeShelfButton("plant", item));
  }
  refreshShelfActiveState();
}

function makeShelfButton(type, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.type = type;
  button.dataset.id = item.id;
  button.dataset.label = item.label;
  button.title = item.label;

  const img = document.createElement("img");
  img.className = "thumb";
  img.src = item.image || "";
  img.alt = item.label;
  img.loading = "lazy";
  img.onerror = () => {
    img.src =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect width='100%25' height='100%25' fill='%23ece9de'/%3E%3Cpath d='M20 82h80' stroke='%23988f79' stroke-width='8'/%3E%3Ccircle cx='60' cy='50' r='22' fill='%2391b26f'/%3E%3C/svg%3E";
  };

  button.append(img);
  button.addEventListener("click", () => {
    const isSameActive =
      state.activeTool &&
      state.activeTool.type === type &&
      state.activeTool.item.id === item.id;
    state.activeTool = isSameActive ? null : { type, item };
    refreshShelfActiveState();
    if (state.activeTool) {
      setStatus(`Tool active: ${item.label}. Click inside the boundary to place.`, false);
      return;
    }
    setStatus("Placement tool off. Click grid to paint pavers.", false);
  });
  return button;
}

function refreshShelfActiveState() {
  const buttons = document.querySelectorAll(".shelf button");
  for (const button of buttons) {
    const isActive =
      state.activeTool &&
      button.dataset.type === state.activeTool.type &&
      button.dataset.id === state.activeTool.item.id;
    button.classList.toggle("active", Boolean(isActive));
  }
}

function setStatus(message, isError) {
  if (!statusText) {
    return;
  }
  statusText.textContent = message;
  statusText.classList.toggle("error", Boolean(isError));
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
