/* ════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════ */
let imgLoaded    = false;
let origData     = null;
let maskData     = null;      // Float32Array: 0.0=no paint, 1.0=full paint
let objectMask   = null;      // Uint8Array: 1=AI/protect zone
let curColor     = '#ff4d6d';
let curOp        = .80;
let curBl        = .35;
let curFinish    = 'matte';
let curTool      = 'fill';
let curView      = 'front';
let imgB64       = null;
let imgMime      = null;
let curMode      = 'color';   // 'color' | 'texture'
let textureImg   = null;
let textureScale = 0.25;
let isErasing    = false;
let isProtecting = false;

// ── Zoom / Pan state ─────────────────────────────
let zoomLevel  = 1.0;
let panX       = 0;
let panY       = 0;
let isPanning  = false;
let panStartX  = 0;
let panStartY  = 0;
let spaceDown  = false;

// ── History (Undo / Redo) ──────────────────────────────────────
const MAX_HISTORY = 20;
// Each entry stores both paint mask and protect mask snapshots
let undoStack = [];
let redoStack = [];

function saveHistory() {
  if (!maskData) return;
  undoStack.push({
    mask:    maskData.slice(),
    protect: objectMask ? objectMask.slice() : null,
  });
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  updateUndoRedoBtns();
}

function undo() {
  if (!undoStack.length || !imgLoaded) return;
  redoStack.push({ mask: maskData.slice(), protect: objectMask ? objectMask.slice() : null });
  const snap = undoStack.pop();
  maskData   = snap.mask;
  objectMask = snap.protect;
  redrawPaint();
  drawProtectOverlay();
  updateUndoRedoBtns();
  setStatus('↩ <b>Undo</b>');
}

function redo() {
  if (!redoStack.length || !imgLoaded) return;
  undoStack.push({ mask: maskData.slice(), protect: objectMask ? objectMask.slice() : null });
  const snap = redoStack.pop();
  maskData   = snap.mask;
  objectMask = snap.protect;
  redrawPaint();
  drawProtectOverlay();
  updateUndoRedoBtns();
  setStatus('↪ <b>Redo</b>');
}

function updateUndoRedoBtns() {
  const u = document.getElementById('tbtn-undo');
  const r = document.getElementById('tbtn-redo');
  if (u) u.disabled = undoStack.length === 0;
  if (r) r.disabled = redoStack.length === 0;
}

// ── Keyboard shortcuts ───────────────────────────────────────
document.addEventListener('keydown', e => {
  // Don't fire if typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); return; }

  switch (e.key) {
    case 'f': case 'F': setTool('fill');    break;
    case 'e': case 'E': setTool('erase');   break;
    case 'p': case 'P': setTool('protect'); break;
    case 'i': case 'I': setTool('eyedrop'); break;
    case 'b': case 'B': toggleBeforeAfter(); break;
    case 'Delete': case 'Backspace': clearAll(); break;
    case '+': case '=': zoomStep(1.25); break;
    case '-': case '_': zoomStep(0.8);  break;
    case '0': zoomReset(); break;
    case '?': toggleShortcuts(); break;
    case 'F11': e.preventDefault(); toggleFullscreen(); break;
    case ' ':
      if (!spaceDown) { spaceDown = true; zone.classList.add('pan-ready'); }
      e.preventDefault(); break;
  }
});
document.addEventListener('keyup', e => {
  if (e.key === ' ') { spaceDown = false; zone.classList.remove('pan-ready'); if (isPanning) endPan(); }
});

const overlayC = document.getElementById('overlay-canvas');
const overlayX = overlayC.getContext('2d');

const mainC   = document.getElementById('main-canvas');
const paintC  = document.getElementById('paint-canvas');
const mainX   = mainC.getContext('2d');
const paintX  = paintC.getContext('2d');
const annoSVG = document.getElementById('anno-svg');
const zone    = document.getElementById('canvas-zone');

/* ════════════════════════════════════════════════
   PALETTE
════════════════════════════════════════════════ */
const COLORS = [
  ['#FFFFFF','Pure White'],['#F5F0E8','Linen'],['#E8DCC8','Warm Sand'],['#D4C5A9','Oat'],
  ['#C9A882','Caramel'],  ['#A67C52','Walnut'],  ['#8B5E3C','Chestnut'], ['#5C3D2E','Bark'],
  ['#F9E4B7','Buttercup'],['#F5C518','Sunflower'],['#E8A838','Amber'],   ['#C4622D','Terracotta'],
  ['#B33A3A','Brick'],    ['#E84855','Crimson'],  ['#FF4D6D','Coral Rouge'],['#FF6B8A','Blush'],
  ['#4A7C59','Forest Sage'],['#2D5A27','Deep Forest'],['#6BAF6D','Meadow'],['#A8C5A0','Mist'],
  ['#4A9EAF','Ocean'],    ['#1B6CA8','Cobalt'],   ['#0D3B6E','Midnight'], ['#7C3AED','Amethyst'],
  ['#37474F','Slate'],    ['#263238','Charcoal'], ['#546E7A','Steel'],    ['#90A4AE','Silver'],
  ['#CE93D8','Wisteria'], ['#9C27B0','Aubergine'],['#FFF9C4','Cream'],    ['#FFF3E0','Ivory'],
];

const palEl = document.getElementById('palette');
COLORS.forEach(([hex, name]) => {
  const s = document.createElement('div');
  s.className = 'sw' + (hex === curColor ? ' sel' : '');
  s.style.background = hex; s.title = name;
  s.onclick = () => pickColor(hex, name, s);
  palEl.appendChild(s);
});

function pickColor(hex, name, el) {
  curColor = hex;
  document.getElementById('csb').style.background = hex;
  document.getElementById('chex').textContent = hex.toUpperCase();
  document.getElementById('cname').textContent = name;
  document.getElementById('color-input').value = hex;
  document.querySelectorAll('.sw').forEach(s => s.classList.remove('sel'));
  if (el) el.classList.add('sel');
  if (imgLoaded && maskData) redrawPaint();
}

function setColor(hex, name) {
  curColor = hex;
  document.getElementById('csb').style.background = hex;
  document.getElementById('chex').textContent = hex.toUpperCase();
  document.getElementById('cname').textContent = name || 'Custom';
  document.querySelectorAll('.sw').forEach(s => s.classList.remove('sel'));
  if (imgLoaded && maskData) redrawPaint();
}

/* ════════════════════════════════════════════════
   FILE LOAD
════════════════════════════════════════════════ */
function handleFile(e) { loadImgFile(e.target.files[0]); }

zone.addEventListener('dragover', e => { e.preventDefault(); document.getElementById('drop-zone').classList.add('drag-over'); });
zone.addEventListener('dragleave', () => document.getElementById('drop-zone').classList.remove('drag-over'));
zone.addEventListener('drop', e => {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) loadImgFile(f);
});

function loadImgFile(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    imgB64  = ev.target.result.split(',')[1];
    imgMime = ev.target.result.split(';')[0].split(':')[1];
    const img = new Image();
    img.onload = () => initCanvas(img);
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function initCanvas(img) {
  const pad  = 40;
  const maxW = zone.clientWidth  - pad;
  const maxH = zone.clientHeight - pad;
  const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);

  // Display size (visual size in CSR grid/layout)
  const displayW = Math.round(img.naturalWidth  * ratio);
  const displayH = Math.round(img.naturalHeight * ratio);

  // High resolution internal size (decoupled from display size)
  // Capped at 4096 to prevent memory crashes, but allowing original if smaller
  const maxInternal = 4096;
  const iRatio = Math.min(maxInternal / img.naturalWidth, maxInternal / img.naturalHeight, 1);
  const W = Math.round(img.naturalWidth  * iRatio);
  const H = Math.round(img.naturalHeight * iRatio);

  const offL = Math.round((zone.clientWidth  - displayW) / 2);
  const offT = Math.round((zone.clientHeight - displayH) / 2);

  [mainC, paintC, document.getElementById('overlay-canvas')].forEach(c => {
    // Internal pixel resolution
    c.width = W; c.height = H;
    // CSS visual size
    c.style.width  = displayW + 'px';
    c.style.height = displayH + 'px';
    c.style.left   = offL + 'px';
    c.style.top    = offT + 'px';
  });

  annoSVG.setAttribute('viewBox', `0 0 ${W} ${H}`);
  annoSVG.setAttribute('width', W);
  annoSVG.setAttribute('height', H);
  annoSVG.style.width  = displayW + 'px';
  annoSVG.style.height = displayH + 'px';
  annoSVG.style.left   = offL + 'px';
  annoSVG.style.top    = offT + 'px';

  // Draw image at full canvas resolution
  mainX.drawImage(img, 0, 0, W, H);
  origData   = mainX.getImageData(0, 0, W, H);
  maskData   = new Float32Array(W * H);
  objectMask = null;

  paintX.clearRect(0, 0, W, H);
  annoSVG.innerHTML = '';

  imgLoaded = true;
  undoStack = []; redoStack = []; // reset history for new image
  updateUndoRedoBtns();
  document.getElementById('drop-zone').classList.add('hidden');
  document.getElementById('apply-btn').disabled = false;
  // Show the "New Image" floating button now that a photo is loaded
  const btnNew = document.getElementById('btn-new-image');
  if (btnNew) btnNew.style.display = 'flex';
  // Exit before/after mode if it was active
  if (baActive) toggleBeforeAfter();
  setStatus(`<b>Image Loaded</b> (${W}x${H}px) · Click walls to paint`);
}

/* ════════════════════════════════════════════════
   CANVAS CLICK
════════════════════════════════════════════════ */
// ── Fill: single click ───────────────────────────────────────────────────────
mainC.addEventListener('click', e => {
  if (!imgLoaded || curTool !== 'fill') return;
  const rect = mainC.getBoundingClientRect();
  const sx = mainC.width  / rect.width;
  const sy = mainC.height / rect.height;
  const x  = Math.round((e.clientX - rect.left) * sx);
  const y  = Math.round((e.clientY - rect.top)  * sy);
  if (x < 0 || y < 0 || x >= mainC.width || y >= mainC.height) return;
  if (objectMask && objectMask[y * mainC.width + x]) {
    setStatus('⚠ <b>Object detected here</b> — click on a wall area to paint it');
    return;
  }
  saveHistory(); // snapshot before fill
  setStatus('⏳ <b>Filling…</b>');
  // Defer fill by one frame so the status message paints before the CPU-heavy work
  requestAnimationFrame(() => {
    const tol    = parseInt(document.getElementById('tol').value);
    const filled = floodFill(x, y, tol);
    redrawPaint();
    setStatus(`<b>Filled</b> ${filled.toLocaleString()} pixels`);
  });
});

// ── Eyedropper: click to sample colour from image ───────────────────────────
mainC.addEventListener('click', e => {
  if (!imgLoaded || curTool !== 'eyedrop') return;
  const [x, y] = getCanvasXY(e);
  if (x < 0 || y < 0 || x >= mainC.width || y >= mainC.height) return;
  const px = origData.data;
  const i  = (y * mainC.width + x) * 4;
  const r  = px[i], g = px[i+1], b = px[i+2];
  const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('').toUpperCase();
  setColor(hex, 'Sampled');
  document.getElementById('color-input').value = hex;
  setStatus(`🔬 <b>Picked</b> ${hex} from image`);
  setTool('fill'); // auto-switch back to fill after picking
});

// ── Pan: Space+drag or middle-mouse drag ─────────────────────────────────────
function startPan(e) {
  isPanning = true;
  const src = e.touches ? e.touches[0] : e;
  panStartX = src.clientX - panX;
  panStartY = src.clientY - panY;
  zone.classList.add('panning');
  zone.classList.remove('pan-ready');
}
function movePan(e) {
  if (!isPanning) return;
  const src = e.touches ? e.touches[0] : e;
  panX = src.clientX - panStartX;
  panY = src.clientY - panStartY;
  applyZoomPan();
}
function endPan() {
  isPanning = false;
  zone.classList.remove('panning');
  if (spaceDown) zone.classList.add('pan-ready');
}

// Middle-mouse pan
zone.addEventListener('mousedown', e => {
  if (e.button === 1) { e.preventDefault(); startPan(e); }
  if (e.button === 0 && spaceDown) { e.preventDefault(); startPan(e); }
});
window.addEventListener('mousemove', e => { if (isPanning) movePan(e); });
window.addEventListener('mouseup',   e => { if (isPanning && (e.button === 1 || e.button === 0)) endPan(); });

// Touch pan (two fingers)
let lastTouchDist = 0;
zone.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    e.preventDefault();
    lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    // Use midpoint as pan start
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    panStartX = mx - panX; panStartY = my - panY;
    isPanning = true;
  }
}, { passive: false });
zone.addEventListener('touchmove', e => {
  if (e.touches.length === 2) {
    e.preventDefault();
    // Pinch zoom
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (lastTouchDist > 0) {
      const delta = dist / lastTouchDist;
      zoomStep(delta, true);
    }
    lastTouchDist = dist;
    // Pinch pan
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    panX = mx - panStartX; panY = my - panStartY;
    applyZoomPan();
  }
}, { passive: false });
zone.addEventListener('touchend', () => { if (isPanning) endPan(); lastTouchDist = 0; });

// Scroll wheel zoom
zone.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1.12 : 0.9;
  zoomStep(delta, true);
}, { passive: false });

// ── Erase: drag brush ────────────────────────────────────────────────────────
function getCanvasXY(e) {
  const rect = mainC.getBoundingClientRect();
  const sx = mainC.width  / rect.width;
  const sy = mainC.height / rect.height;
  // Support both mouse and touch
  const src = e.touches ? e.touches[0] : e;
  return [
    Math.round((src.clientX - rect.left) * sx),
    Math.round((src.clientY - rect.top)  * sy),
  ];
}

function applyEraseBrush(e) {
  if (!imgLoaded) return;
  const [x, y] = getCanvasXY(e);
  if (x < 0 || y < 0 || x >= mainC.width || y >= mainC.height) return;
  const r = parseInt(document.getElementById('brush-size')?.value || 30);
  eraseAt(x, y, r);
  redrawPaint();
  setStatus(`<b>Erasing</b> — release to finish`);
}

mainC.addEventListener('mousedown', e => {
  if (!imgLoaded) return;
  if (curTool === 'erase')   { saveHistory(); isErasing = true; applyEraseBrush(e); }
  if (curTool === 'protect') { saveHistory(); isProtecting = true; applyProtectBrush(e); }
});
mainC.addEventListener('mousemove', e => {
  if (isErasing   && curTool === 'erase')   applyEraseBrush(e);
  if (isProtecting && curTool === 'protect') applyProtectBrush(e);
  // Draw brush cursor preview for erase / protect tools
  if (imgLoaded && (curTool === 'erase' || curTool === 'protect')) {
    drawBrushCursor(e);
  } else {
    clearBrushCursor();
  }
});
mainC.addEventListener('mouseleave', clearBrushCursor);

// ── Brush cursor preview ─────────────────────────────────────────────────────
let brushCursorActive = false;
function drawBrushCursor(e) {
  const rect = mainC.getBoundingClientRect();
  // Position in CSS pixels relative to canvas element
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // Brush radius in CSS pixels (scale canvas-pixel radius → display pixels)
  const r  = parseInt(document.getElementById('brush-size')?.value || 30);
  const scaleX = rect.width / mainC.width;
  const rDisplay = r * scaleX;

  const W = overlayC.width, H = overlayC.height;
  overlayX.clearRect(0, 0, W, H);

  // Re-draw protect overlay if it exists
  if (objectMask) {
    const img = new ImageData(W, H);
    for (let i = 0; i < objectMask.length; i++) {
      if (!objectMask[i]) continue;
      const p = i * 4;
      img.data[p] = 255; img.data[p+1] = 160; img.data[p+2] = 0; img.data[p+3] = 55;
    }
    overlayX.putImageData(img, 0, 0);
  }

  // Draw cursor ring in canvas coordinate space (scale CSS px → canvas px)
  const canvasCx = cx / scaleX;
  const canvasCy = cy / (rect.height / mainC.height);

  overlayX.save();
  overlayX.beginPath();
  overlayX.arc(canvasCx, canvasCy, r, 0, Math.PI * 2);
  const isProtect = curTool === 'protect';
  overlayX.strokeStyle = isProtect ? 'rgba(240,180,41,0.9)' : 'rgba(255,255,255,0.85)';
  overlayX.lineWidth   = Math.max(1.5, 2 / scaleX);
  overlayX.setLineDash([Math.max(3, 6/scaleX), Math.max(2, 4/scaleX)]);
  overlayX.stroke();
  overlayX.beginPath();
  overlayX.arc(canvasCx, canvasCy, r, 0, Math.PI * 2);
  overlayX.strokeStyle = isProtect ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.4)';
  overlayX.lineWidth   = Math.max(3, 4 / scaleX);
  overlayX.setLineDash([]);
  overlayX.globalCompositeOperation = 'destination-over';
  overlayX.stroke();
  overlayX.restore();
  brushCursorActive = true;
}

function clearBrushCursor() {
  if (!brushCursorActive) return;
  const W = overlayC.width, H = overlayC.height;
  overlayX.clearRect(0, 0, W, H);
  if (objectMask) drawProtectOverlay(); // restore protect tint
  brushCursorActive = false;
}
window.addEventListener('mouseup', () => {
  if (isErasing)   { isErasing   = false; setStatus('<b>Done erasing</b>'); }
  if (isProtecting){ isProtecting = false; setStatus('<b>Protection applied</b> — now click walls to fill'); }
});
mainC.addEventListener('touchstart', e => {
  if (!imgLoaded) return;
  if (curTool === 'erase')   { e.preventDefault(); saveHistory(); isErasing = true; applyEraseBrush(e); }
  if (curTool === 'protect') { e.preventDefault(); isProtecting = true; applyProtectBrush(e); }
}, { passive: false });
mainC.addEventListener('touchmove', e => {
  if (isErasing   && curTool === 'erase')   { e.preventDefault(); applyEraseBrush(e); }
  if (isProtecting && curTool === 'protect') { e.preventDefault(); applyProtectBrush(e); }
}, { passive: false });
window.addEventListener('touchend', () => { isErasing = false; isProtecting = false; });

/* ════════════════════════════════════════════════
   FLOOD FILL (stack-based)
════════════════════════════════════════════════ */
function floodFill(sx, sy, tolerance) {
  const W = mainC.width, H = mainC.height;
  const d = origData.data;
  const si = (sy * W + sx) * 4;
  const sr = d[si], sg = d[si+1], sb = d[si+2];

  // Seed-color tolerance (how different a pixel can be from the clicked color)
  const thresh = tolerance * tolerance * 3;

  // Edge threshold: stops fill when crossing a sharp local boundary between
  // neighboring pixels. This is the key wall/object separator — visible edges
  // (sofa outline, picture frame, door edge) have a large local gradient.
  const edgeSlider = document.getElementById('edge-tol');
  const edgeTol = edgeSlider ? parseInt(edgeSlider.value) : 28;
  const edgeThresh = edgeTol * edgeTol * 3;

  const visited = new Uint8Array(W * H);
  const stack   = [[sx, sy]];
  visited[sy * W + sx] = 1;
  let count = 0;

  while (stack.length) {
    const [px, py] = stack.pop();
    maskData[py * W + px] = 1;
    count++;
    // Current pixel color (used for local edge check)
    const ci = (py * W + px) * 4;
    const cr = d[ci], cg = d[ci+1], cb = d[ci+2];

    for (const [nx, ny] of [[px+1,py],[px-1,py],[px,py+1],[px,py-1]]) {
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (visited[ni]) continue;
      // Block AI-detected object regions
      if (objectMask && objectMask[ni]) { visited[ni] = 1; continue; }
      visited[ni] = 1;
      const pi = ni * 4;
      const nr = d[pi], ng = d[pi+1], nb = d[pi+2];

      // 1. Must be color-similar to the seed pixel
      const dr = nr-sr, dg = ng-sg, db = nb-sb;
      if (dr*dr + dg*dg + db*db > thresh) continue;

      // 2. Edge-aware: stop at sharp local transitions (object outlines)
      //    If the step from current → neighbor is a big jump, it is an edge.
      const er = nr-cr, eg = ng-cg, eb = nb-cb;
      if (er*er + eg*eg + eb*eb > edgeThresh) continue;

      stack.push([nx, ny]);
    }
  }
  return count;
}

// Soft feather-brush erase with Gaussian-style radial falloff
function eraseAt(cx, cy, r) {
  const W = mainC.width, H = mainC.height;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > r) continue;
      const nx = cx+dx, ny = cy+dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      // Feather falloff: strength = 1 at centre, 0 at the edge
      const t        = dist / r;               // 0 (centre) → 1 (rim)
      const strength = Math.pow(1 - t, 1.5);  // smooth concave curve
      const idx = ny * W + nx;
      maskData[idx] = Math.max(0, maskData[idx] - strength * 0.18);
    }
  }
}

/* ── PROTECT BRUSH ──────────────────────────────────────────────────────
   Paints pixels into objectMask so fill will never enter them.            */
function applyProtectBrush(e) {
  if (!imgLoaded) return;
  const [x, y] = getCanvasXY(e);
  if (x < 0 || y < 0 || x >= mainC.width || y >= mainC.height) return;
  const r = parseInt(document.getElementById('brush-size')?.value || 30);
  const W = mainC.width, H = mainC.height;
  if (!objectMask) objectMask = new Uint8Array(W * H);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > r) continue;
      const nx = x+dx, ny = y+dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      objectMask[ny * W + nx] = 1;
      // Also soft-erase any paint already there
      const idx = ny * W + nx;
      maskData[idx] = Math.max(0, maskData[idx] - 0.3);
    }
  }
  redrawPaint();
  drawProtectOverlay();
  setStatus('<b>Protected</b> — fill won\'t enter shaded areas');
}

// Render protected zones as a semi-transparent amber tint on the overlay canvas
function drawProtectOverlay() {
  const W = mainC.width, H = mainC.height;
  overlayX.clearRect(0, 0, W, H);
  if (!objectMask) return;
  const img = new ImageData(W, H);
  for (let i = 0; i < objectMask.length; i++) {
    if (!objectMask[i]) continue;
    const p = i * 4;
    img.data[p]   = 255; // R
    img.data[p+1] = 160; // G
    img.data[p+2] = 0;   // B
    img.data[p+3] = 55;  // A — subtle amber tint
  }
  overlayX.putImageData(img, 0, 0);
}

/* Duplicate protect listeners removed — handled by the combined listeners above */

function clearAll() {
  if (!imgLoaded) return;
  saveHistory(); // allow undoing a clear
  maskData && maskData.fill(0.0);
  objectMask = null;
  overlayX.clearRect(0, 0, mainC.width, mainC.height);
  paintX.clearRect(0, 0, mainC.width, mainC.height);
  annoSVG.innerHTML = '';
  document.getElementById('ai-result').classList.remove('on');
  document.getElementById('wall-chips').innerHTML = '';
  document.getElementById('obj-chips').innerHTML  = '';
  setStatus('<b>Cleared</b> — click wall to paint');
}

/* ════════════════════════════════════════════════
   RENDER PAINT (luminance-based 3D shading)
════════════════════════════════════════════════ */
function redrawPaint() {
  if (!imgLoaded || !maskData) return;
  const W = mainC.width, H = mainC.height;
  paintX.clearRect(0, 0, W, H);

  let shine = 0;
  if      (curFinish === 'gloss')    shine = .60;
  else if (curFinish === 'satin')    shine = .30;
  else if (curFinish === 'eggshell') shine = .12;

  if (curMode === 'texture' && textureImg) {
    /* ── TEXTURE MODE ──────────────────────────────────────── */
    const tileW = Math.max(8, Math.round(W * textureScale));
    const tileH = Math.round(tileW * textureImg.naturalHeight / textureImg.naturalWidth);

    // Render shaded tile into an offscreen canvas (regular canvas for broad compatibility)
    const offC = document.createElement('canvas');
    offC.width = tileW; offC.height = tileH;
    const offX = offC.getContext('2d');
    offX.drawImage(textureImg, 0, 0, tileW, tileH);
    const tileData = offX.getImageData(0, 0, tileW, tileH);
    const td = tileData.data;
    for (let i = 0; i < td.length; i += 4) {
      const lum = (0.299*td[i]+0.587*td[i+1]+0.114*td[i+2])/255;
      const shade = 0.40 + lum * 0.80;
      const sh = shine * Math.pow(lum, 1.8);
      td[i]   = Math.min(255, td[i]   * shade * (1-sh) + 255*sh);
      td[i+1] = Math.min(255, td[i+1] * shade * (1-sh) + 255*sh);
      td[i+2] = Math.min(255, td[i+2] * shade * (1-sh) + 255*sh);
    }
    offX.putImageData(tileData, 0, 0);

    // Create tiling pattern directly from the shaded tile canvas
    const pat = paintX.createPattern(offC, 'repeat');

    // Build mask clip canvas — use maskData fractional value as alpha
    const clipCanvas = document.createElement('canvas');
    clipCanvas.width = W; clipCanvas.height = H;
    const clipX = clipCanvas.getContext('2d');
    // Build clip image via ImageData for performance
    const clipImg = new ImageData(W, H);
    for (let i = 0; i < maskData.length; i++) {
      if (maskData[i] <= 0) continue;
      const p = i * 4;
      clipImg.data[p] = clipImg.data[p+1] = clipImg.data[p+2] = 255;
      clipImg.data[p+3] = Math.round(maskData[i] * 255);
    }
    clipX.putImageData(clipImg, 0, 0);

    // Draw texture, clip to mask
    paintX.save();
    paintX.globalAlpha = curOp;
    paintX.fillStyle = pat;
    paintX.fillRect(0, 0, W, H);
    paintX.restore();

    paintX.save();
    paintX.globalCompositeOperation = 'destination-in';
    paintX.drawImage(clipCanvas, 0, 0);
    paintX.restore();

    // Blend original image back
    if (curBl > 0) {
      const blClipC = document.createElement('canvas');
      blClipC.width = W; blClipC.height = H;
      const blClipX = blClipC.getContext('2d');
      blClipX.drawImage(mainC, 0, 0);
      blClipX.globalCompositeOperation = 'destination-in';
      blClipX.drawImage(clipCanvas, 0, 0);

      paintX.save();
      paintX.globalAlpha = curBl * curOp;
      paintX.globalCompositeOperation = 'source-over';
      paintX.drawImage(blClipC, 0, 0);
      paintX.restore();
    }

  } else {
    /* ── COLOR MODE ──────────────────────────────────────── */
    const col = hexToRgb(curColor);
    if (!col) return;
    const dst = new ImageData(W, H);
    const src = origData.data;
    const dd  = dst.data;
    for (let i = 0; i < maskData.length; i++) {
      if (!maskData[i]) continue;
      const pi  = i * 4;
      const oR  = src[pi], oG = src[pi+1], oB = src[pi+2];
      const lum = (0.299*oR + 0.587*oG + 0.114*oB) / 255;
      const shade = 0.40 + lum * 0.80;
      const sh    = shine * Math.pow(lum, 1.8);
      const bl    = curBl;
      const pR = col.r * shade * (1-sh) + 255*sh;
      const pG = col.g * shade * (1-sh) + 255*sh;
      const pB = col.b * shade * (1-sh) + 255*sh;
      dd[pi]   = Math.min(255, pR*(1-bl) + oR*bl);
      dd[pi+1] = Math.min(255, pG*(1-bl) + oG*bl);
      dd[pi+2] = Math.min(255, pB*(1-bl) + oB*bl);
      dd[pi+3] = Math.round(curOp * 255);
    }
    paintX.putImageData(dst, 0, 0);
  }

  applyView();
  // Keep before/after view in sync if it's open
  if (typeof baActive !== 'undefined' && baActive) {
    syncBASliderLayout();
    renderBASplit();
  }
}

/* ════════════════════════════════════════════════
   3D PERSPECTIVE
════════════════════════════════════════════════ */
const VIEWS = {
  front: 'perspective(1800px) rotateY(0deg)   rotateX(0deg)',
  left:  'perspective(1800px) rotateY(12deg)  rotateX(0deg)',
  right: 'perspective(1800px) rotateY(-12deg) rotateX(0deg)',
  tilt:  'perspective(1800px) rotateY(0deg)   rotateX(-10deg)',
};

function setView(el, v) {
  curView = v;
  document.querySelectorAll('.vbtn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  applyView();
}

function applyView() {
  const t = VIEWS[curView] || VIEWS.front;
  // Apply transform to the canvas-zone so all layers move together
  const zone = document.getElementById('canvas-zone');
  zone.style.perspective = '1800px';
  // Extract just the rotate parts to apply to a wrapper; apply to each canvas
  mainC.style.transform  = t;
  paintC.style.transform = t;
  document.getElementById('overlay-canvas').style.transform = t;
  annoSVG.style.transform = t;
  // Keep BA slider transform in sync
  if (typeof baActive !== 'undefined' && baActive) syncBASliderLayout();
}

/* ════════════════════════════════════════════════
   SETTINGS
════════════════════════════════════════════════ */
function onOp(v) { curOp = v/100; document.getElementById('sv-op').textContent = v+'%'; if (imgLoaded && maskData) redrawPaint(); }
function onBl(v) { curBl = v/100; document.getElementById('sv-bl').textContent = v+'%'; if (imgLoaded && maskData) redrawPaint(); }

function setFinish(el, f) {
  curFinish = f;
  document.querySelectorAll('.fchip').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  if (imgLoaded && maskData) redrawPaint();
}

function setTool(t) {
  curTool = t;
  ['fill','erase','protect','eye'].forEach(k => {
    const b = document.getElementById('tbtn-' + (k === 'eye' ? 'eye' : k));
    if (b) b.classList.toggle('active', (k === 'eye' ? 'eyedrop' : k) === t);
  });
  const isBrush   = (t === 'erase' || t === 'protect');
  const isEye     = (t === 'eyedrop');
  mainC.classList.toggle('brush-mode',   isBrush);
  mainC.classList.toggle('eyedrop-mode', isEye);
  mainC.style.cursor = isBrush ? 'none' : isEye ? 'crosshair' : 'crosshair';
  if (!isBrush) clearBrushCursor();
}

/* ════════════════════════════════════════════════
   BEFORE / AFTER SLIDER
════════════════════════════════════════════════ */
let baActive    = false;
let baDragging  = false;
let baSplitX    = 0.5; // fraction 0→1 of slider position

const baSlider  = document.getElementById('ba-slider');
const baCanvas  = document.getElementById('ba-canvas');
const baDivider = document.getElementById('ba-divider');
const baCtx     = baCanvas ? baCanvas.getContext('2d') : null;

function toggleBeforeAfter() {
  if (!imgLoaded) { setStatus('⚠ Upload a photo first'); return; }
  baActive = !baActive;
  const btn = document.getElementById('tbtn-ba');
  if (btn) btn.classList.toggle('active', baActive);

  if (baActive) {
    // Size ba canvas to match internal resolution
    baCanvas.width  = mainC.width;
    baCanvas.height = mainC.height;
    baSlider.style.display = 'block';
    // Match CSS display size & position to the main canvas
    syncBASliderLayout();
    renderBASplit();
    setStatus('⇆ <b>Compare mode</b> — drag the divider');
  } else {
    baSlider.style.display = 'none';
    setStatus('<b>Compare closed</b>');
  }
}

function syncBASliderLayout() {
  // Mirror main canvas CSS position/size onto the ba-slider overlay
  baSlider.style.left   = mainC.style.left;
  baSlider.style.top    = mainC.style.top;
  baSlider.style.width  = mainC.style.width;
  baSlider.style.height = mainC.style.height;
  baSlider.style.transform = mainC.style.transform || '';
  // Position divider line
  baDivider.style.left = (baSplitX * 100) + '%';
}

function renderBASplit() {
  if (!baActive || !baCtx) return;
  const W = baCanvas.width, H = baCanvas.height;
  const splitPx = Math.round(baSplitX * W);

  baCtx.clearRect(0, 0, W, H);

  // LEFT side: BEFORE (original, no paint)
  baCtx.drawImage(mainC, 0, 0);

  // RIGHT side: AFTER (composite with paint)
  // Draw paint only in the right half using clipping
  baCtx.save();
  baCtx.beginPath();
  baCtx.rect(splitPx, 0, W - splitPx, H);
  baCtx.clip();
  baCtx.drawImage(mainC,  0, 0);
  baCtx.drawImage(paintC, 0, 0);
  baCtx.restore();
}

// Drag logic — works on both mouse and touch
function baGetX(e) {
  const src = e.touches ? e.touches[0] : e;
  const rect = baSlider.getBoundingClientRect();
  return Math.max(0, Math.min(1, (src.clientX - rect.left) / rect.width));
}

baDivider.addEventListener('mousedown',  e => { e.preventDefault(); baDragging = true; baDivider.classList.add('dragging'); });
baDivider.addEventListener('touchstart', e => { e.preventDefault(); baDragging = true; baDivider.classList.add('dragging'); }, { passive: false });

window.addEventListener('mousemove', e => {
  if (!baDragging) return;
  baSplitX = baGetX(e);
  baDivider.style.left = (baSplitX * 100) + '%';
  renderBASplit();
});
window.addEventListener('touchmove', e => {
  if (!baDragging) return;
  baSplitX = baGetX(e);
  baDivider.style.left = (baSplitX * 100) + '%';
  renderBASplit();
}, { passive: true });
window.addEventListener('mouseup',  () => { if (baDragging) { baDragging = false; baDivider.classList.remove('dragging'); } });
window.addEventListener('touchend', () => { if (baDragging) { baDragging = false; baDivider.classList.remove('dragging'); } });

// Also tap anywhere on the ba-slider to move divider instantly
baSlider.addEventListener('click', e => {
  if (e.target === baDivider || baDivider.contains(e.target)) return;
  baSplitX = baGetX(e);
  baDivider.style.left = (baSplitX * 100) + '%';
  renderBASplit();
});

// Re-render whenever paint changes while compare is open
const _origRedraw = redrawPaint;
// (patched below after redrawPaint is defined — see bottom of file)

/* ════════════════════════════════════════════════
   DOWNLOAD WITH WATERMARK
════════════════════════════════════════════════ */
function downloadImage() {
  if (!imgLoaded) { alert('Upload a room photo first.'); return; }

  const W = mainC.width, H = mainC.height;
  const out = document.createElement('canvas');
  out.width  = W; out.height = H;
  const ctx  = out.getContext('2d');

  // 1. Draw composite (room + paint)
  ctx.drawImage(mainC,  0, 0);
  ctx.drawImage(paintC, 0, 0);

  // 2. Watermark — bottom-right pill badge
  const colorName = (document.getElementById('cname')?.textContent || 'Custom');
  const hexCode   = (document.getElementById('chex')?.textContent  || '#FFFFFF');
  const hexRaw    = hexCode.replace('#','');

  // Watermark dimensions — scale with image width
  const scale     = Math.max(1, W / 1200);
  const padX      = Math.round(22 * scale);
  const padY      = Math.round(18 * scale);
  const pillPad   = Math.round(14 * scale);
  const pillH     = Math.round(52 * scale);
  const radius    = Math.round(12 * scale);
  const swatchR   = Math.round(10 * scale);
  const swatchX   = padX + pillPad + swatchR;
  const gap       = Math.round(10 * scale);

  // Fonts
  const titleSize = Math.round(11 * scale);
  const nameSize  = Math.round(15 * scale);
  const hexSize   = Math.round(11 * scale);

  ctx.font = `700 ${titleSize}px "Space Mono", monospace`;
  ctx.letterSpacing = '2px';
  const titleTxt  = 'RAZEL STUDIO';
  const titleW    = ctx.measureText(titleTxt).width;
  ctx.font = `700 ${nameSize}px "DM Sans", sans-serif`;
  const nameW     = ctx.measureText(colorName).width;
  ctx.font        = `400 ${hexSize}px "Space Mono", monospace`;
  const hexW      = ctx.measureText(hexCode).width;
  const textW     = Math.max(titleW, nameW, hexW);
  const pillW     = swatchR * 2 + gap + textW + pillPad * 2;

  const pillX = W - padX - pillW;
  const pillY = H - padY - pillH;

  // Pill background
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur  = Math.round(16 * scale);
  ctx.shadowOffsetY = Math.round(4 * scale);
  ctx.fillStyle   = 'rgba(11,11,15,0.82)';
  roundRect(ctx, pillX, pillY, pillW, pillH, radius);
  ctx.fill();
  ctx.restore();

  // Subtle left accent border
  ctx.save();
  const grad = ctx.createLinearGradient(pillX, pillY, pillX, pillY + pillH);
  grad.addColorStop(0,   '#ff4d6d');
  grad.addColorStop(1,   '#7c3aed');
  ctx.fillStyle = grad;
  roundRect(ctx, pillX, pillY, Math.round(3 * scale), pillH, [radius, 0, 0, radius]);
  ctx.fill();
  ctx.restore();

  // Color swatch circle
  const swatchCY  = pillY + pillH / 2;
  const textLeft  = swatchX + swatchR + gap;

  ctx.save();
  ctx.beginPath();
  ctx.arc(swatchX, swatchCY, swatchR, 0, Math.PI * 2);
  ctx.fillStyle = hexCode;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth   = Math.round(1.5 * scale);
  ctx.stroke();
  ctx.restore();

  // Text: brand title
  ctx.save();
  ctx.font = `700 ${titleSize}px "Space Mono", monospace`;
  ctx.fillStyle   = 'rgba(240,180,41,0.9)';  // gold
  ctx.textBaseline = 'top';
  const textTopY  = pillY + Math.round(9 * scale);
  ctx.fillText(titleTxt, textLeft, textTopY);

  // Text: color name
  ctx.font         = `600 ${nameSize}px "DM Sans", sans-serif`;
  ctx.fillStyle    = '#f0f0f8';
  ctx.textBaseline = 'top';
  ctx.fillText(colorName, textLeft, textTopY + titleSize + Math.round(3 * scale));

  // Text: hex code
  ctx.font         = `400 ${hexSize}px "Space Mono", monospace`;
  ctx.fillStyle    = 'rgba(160,160,184,0.85)';
  ctx.textBaseline = 'top';
  ctx.fillText(hexCode, textLeft, textTopY + titleSize + nameSize + Math.round(6 * scale));
  ctx.restore();

  // Trigger download
  const safeName  = colorName.replace(/\s+/g, '-');
  const filename  = `RazelStudio_${safeName}_${hexRaw}.png`;
  const a = document.createElement('a');
  a.href     = out.toDataURL('image/png');
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setStatus(`⬇ <b>Saved</b> ${filename}`);
}

// Helper: rounded rect path (supports per-corner radii array or single number)
function roundRect(ctx, x, y, w, h, r) {
  if (typeof r === 'number') r = [r, r, r, r];
  const [tl, tr, br, bl] = r;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.quadraticCurveTo(x + w, y,       x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.quadraticCurveTo(x + w, y + h,   x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.quadraticCurveTo(x, y + h,       x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.quadraticCurveTo(x, y,           x + tl, y);
  ctx.closePath();
}

/* ════════════════════════════════════════════════
   MOBILE TAB SWITCHER
════════════════════════════════════════════════ */
function switchTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.mob-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  // Show matching pane — hide others
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tabName));
}

/* ════════════════════════════════════════════════
   TEXTURE MODE
════════════════════════════════════════════════ */
function setMode(m) {
  curMode = m;
  document.getElementById('mode-color').classList.toggle('active', m === 'color');
  document.getElementById('mode-texture').classList.toggle('active', m === 'texture');
  if (imgLoaded && maskData) redrawPaint();
}

function loadTexture(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      textureImg = img;
      const prev = document.getElementById('tex-preview');
      prev.src = ev.target.result;
      prev.classList.add('show');
      document.getElementById('tex-name').textContent = file.name.length > 18 ? file.name.slice(0,15)+'…' : file.name;
      document.querySelectorAll('.ptex').forEach(p => p.classList.remove('sel'));
      // Auto-switch to texture mode when a custom texture is uploaded
      setMode('texture');
      if (imgLoaded && maskData) redrawPaint();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function onTexScale(v) {
  textureScale = v / 100;
  document.getElementById('sv-tex-scale').textContent = v + '%';
  if (imgLoaded && maskData && curMode === 'texture') redrawPaint();
}

/* ── Preset texture patterns ────────────────────────── */
const PRESETS = [
  { name: 'Brick',    draw: drawBrick    },
  { name: 'Wood',     draw: drawWood     },
  { name: 'Marble',   draw: drawMarble   },
  { name: 'Concrete', draw: drawConcrete },
  { name: 'Linen',    draw: drawLinen    },
];

function buildPresets() {
  const grid = document.getElementById('preset-tex-grid');
  PRESETS.forEach((p, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'ptex';
    wrap.title = p.name;
    const c = document.createElement('canvas');
    c.width = 60; c.height = 60;
    p.draw(c.getContext('2d'), 60, 60);
    wrap.appendChild(c);
    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:.55rem;color:var(--sub);text-align:center;padding:2px 0;font-family:"Space Mono",monospace;';
    lbl.textContent = p.name.toUpperCase();
    wrap.appendChild(lbl);
    wrap.onclick = () => selectPreset(idx, wrap);
    grid.appendChild(wrap);
  });
}

function selectPreset(idx, el) {
  document.querySelectorAll('.ptex').forEach(p => p.classList.remove('sel'));
  el.classList.add('sel');
  const bigC = document.createElement('canvas');
  bigC.width = 200; bigC.height = 200;
  PRESETS[idx].draw(bigC.getContext('2d'), 200, 200);
  const img = new Image();
  img.onload = () => {
    textureImg = img;
    const prev = document.getElementById('tex-preview');
    prev.src = img.src;
    prev.classList.add('show');
    document.getElementById('tex-name').textContent = PRESETS[idx].name;
    // Auto-switch to texture mode when a preset is chosen
    setMode('texture');
    if (imgLoaded && maskData) redrawPaint();
  };
  img.src = bigC.toDataURL();
}

/* ── Procedural pattern drawers ──────────────────── */
function drawBrick(ctx, W, H) {
  ctx.fillStyle = '#c0573a'; ctx.fillRect(0,0,W,H);
  const bw=20, bh=10, grout=2;
  for (let row=0; row*bh<H+bh; row++) {
    const off = (row%2===0)?0:bw/2;
    for (let col=-1; col*bw<W+bw; col++) {
      const x=col*bw+off+grout/2, y=row*bh+grout/2;
      const shade = 0.9+Math.random()*.15;
      ctx.fillStyle = `rgba(${Math.round(192*shade)},${Math.round(87*shade)},${Math.round(58*shade)},1)`;
      ctx.fillRect(x, y, bw-grout, bh-grout);
    }
  }
  ctx.strokeStyle='rgba(80,50,40,.5)'; ctx.lineWidth=grout;
  for (let row=0; row*bh<H+bh; row++) {
    ctx.beginPath(); ctx.moveTo(0,row*bh); ctx.lineTo(W,row*bh); ctx.stroke();
    const off=(row%2===0)?0:bw/2;
    for (let col=0; col*bw<W+bw; col++) {
      const x=col*bw+off;
      ctx.beginPath(); ctx.moveTo(x,row*bh); ctx.lineTo(x,(row+1)*bh); ctx.stroke();
    }
  }
}

function drawWood(ctx, W, H) {
  ctx.fillStyle='#8B5E3C'; ctx.fillRect(0,0,W,H);
  for (let i=0;i<24;i++) {
    const y=i*(H/24);
    const c=Math.floor(100+Math.random()*60);
    ctx.strokeStyle=`rgba(${c+20},${Math.floor(c*.6)},${Math.floor(c*.3)},.55)`;
    ctx.lineWidth=1+Math.random()*2;
    ctx.beginPath(); ctx.moveTo(0,y);
    for (let x=0;x<W;x+=4) ctx.lineTo(x, y+Math.sin(x*.18+i)*(1.5+Math.random()));
    ctx.stroke();
  }
}

function drawMarble(ctx, W, H) {
  ctx.fillStyle='#e8e0d8'; ctx.fillRect(0,0,W,H);
  for (let i=0;i<8;i++) {
    ctx.strokeStyle=`rgba(${160+Math.random()*40},${155+Math.random()*40},${150+Math.random()*40},.4)`;
    ctx.lineWidth=0.5+Math.random()*2.5;
    ctx.beginPath(); ctx.moveTo(Math.random()*W, Math.random()*H);
    for (let j=0;j<10;j++) ctx.bezierCurveTo(Math.random()*W,Math.random()*H,Math.random()*W,Math.random()*H,Math.random()*W,Math.random()*H);
    ctx.stroke();
  }
}

function drawConcrete(ctx, W, H) {
  ctx.fillStyle='#9e9e9e'; ctx.fillRect(0,0,W,H);
  const id=ctx.getImageData(0,0,W,H);
  for (let i=0;i<id.data.length;i+=4) {
    const n=Math.floor((Math.random()-.5)*30);
    id.data[i]+=n; id.data[i+1]+=n; id.data[i+2]+=n;
  }
  ctx.putImageData(id,0,0);
  ctx.strokeStyle='rgba(70,70,70,.2)'; ctx.lineWidth=1;
  [H*.33,H*.67].forEach(y=>{ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();});
  [W*.33,W*.67].forEach(x=>{ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();});
}

function drawLinen(ctx, W, H) {
  ctx.fillStyle='#f5efe6'; ctx.fillRect(0,0,W,H);
  const spacing=3;
  ctx.strokeStyle='rgba(180,160,130,.3)'; ctx.lineWidth=1;
  for (let y=0;y<H;y+=spacing){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  ctx.strokeStyle='rgba(180,160,130,.18)';
  for (let x=0;x<W;x+=spacing){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
}

buildPresets();

/* ════════════════════════════════════════════════
   AI DETECTION
════════════════════════════════════════════════ */
async function runAI() {
  if (!imgLoaded) { alert('Please upload a room photo first.'); return; }
  document.getElementById('ai-load').classList.add('on');
  document.getElementById('ai-result').classList.remove('on');
  annoSVG.innerHTML = '';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imgMime, data: imgB64 } },
            { type: 'text', text: `Analyze this room image. Return ONLY raw JSON (no markdown fences):
{
  "room_type": "Living Room",
  "summary": "one sentence about the room",
  "walls": [{"label":"back wall","x":0.0,"y":0.0,"w":1.0,"h":0.55}],
  "objects": [{"label":"sofa","x":0.10,"y":0.55,"w":0.40,"h":0.35}]
}
CRITICAL Rules:
- x,y,w,h are fractions (0.0-1.0) of image width/height
- x = left edge/width, y = top edge/height, w = box width/width, h = box height/height
- walls: ONLY the bare paintable wall surface. Do NOT include furniture or mounted items.
- objects: detect EVERY non-wall item — ESPECIALLY items that may appear the same color as the wall:
    • Light fixtures: tube lights, track lights, spotlights, pendant lights, wall lamps, ceiling lights, fan with light
    • Framed artwork, photo frames, mirrors (even if frame color matches wall)
    • Wall switches, electrical outlets, sockets, plug points
    • Air conditioners, vents, exhaust fans
    • Curtain rods, curtains, blinds
    • Shelves, cabinets, wardrobes
    • TV, monitors, screens
    • Sofas, chairs, tables, rugs
    • Any other wall-mounted or room items regardless of color
- Bounding boxes for objects must be TIGHT and must NOT include bare wall behind them.
- IMPORTANT: wall boxes and object boxes must NOT overlap.
- Be pixel-accurate.` }
          ]
        }]
      })
    });
    const data   = await resp.json();
    const raw    = data.content.map(c => c.text || '').join('');
    const clean  = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const walls  = parsed.walls   || [];
    const objs   = parsed.objects || [];

    document.getElementById('ai-room').textContent = parsed.room_type || 'Room';
    document.getElementById('ai-sum').textContent  = parsed.summary   || '';

    const wc = document.getElementById('wall-chips'); wc.innerHTML = '';
    walls.forEach(w => {
      const ch = document.createElement('div');
      ch.className = 'chip wall-chip';
      ch.textContent = '🧱 ' + w.label;
      wc.appendChild(ch);
    });

    const oc = document.getElementById('obj-chips'); oc.innerHTML = '';
    objs.forEach(o => {
      const ch = document.createElement('div');
      ch.className = 'chip obj-chip';
      ch.textContent = o.label;
      oc.appendChild(ch);
    });

    // ── Build pixel-level object protection mask from bounding boxes ──
    buildObjectMask(objs);
    drawProtectOverlay();

    drawBoxes(walls, objs);
    document.getElementById('ai-result').classList.add('on');
    const aiHint = objectMask ? ' · <b>Object-aware fill ON</b>' : '';
    setStatus(`<b>AI detected</b> ${walls.length} wall(s) · ${objs.length} object(s)${aiHint}`);
  } catch (err) {
    console.error(err);
    document.getElementById('ai-result').classList.add('on');
    document.getElementById('ai-room').textContent = 'Error';
    document.getElementById('ai-sum').textContent  = 'Could not parse AI response. Please try again.';
  } finally {
    document.getElementById('ai-load').classList.remove('on');
  }
}

/* ════════════════════════════════════════════════
   OBJECT PROTECTION MASK
════════════════════════════════════════════════ */
function buildObjectMask(objs) {
  const W = mainC.width, H = mainC.height;
  objectMask = new Uint8Array(W * H);
  objs.forEach(o => {
    const x1 = Math.max(0, Math.round(o.x * W));
    const y1 = Math.max(0, Math.round(o.y * H));
    const x2 = Math.min(W, Math.round((o.x + o.w) * W));
    const y2 = Math.min(H, Math.round((o.y + o.h) * H));
    for (let py = y1; py < y2; py++)
      for (let px = x1; px < x2; px++)
        objectMask[py * W + px] = 1;
  });
}

/* ════════════════════════════════════════════════
   SVG BOUNDING BOXES
════════════════════════════════════════════════ */
function drawBoxes(walls, objects) {
  annoSVG.innerHTML = '';
  const W = mainC.width, H = mainC.height;
  walls.forEach(w   => drawBox(w, W, H, '#2dd4bf', 'rgba(45,212,191,.07)', '🧱 ' + w.label, true));
  objects.forEach(o => drawBox(o, W, H, '#ff4d6d', 'rgba(255,77,109,.08)', o.label, false));
}

function drawBox(item, W, H, stroke, fill, label, isWall) {
  const x  = Math.max(0, Math.min(.99, item.x)) * W;
  const y  = Math.max(0, Math.min(.99, item.y)) * H;
  const bw = Math.max(.01, Math.min(1 - item.x, item.w)) * W;
  const bh = Math.max(.01, Math.min(1 - item.y, item.h)) * H;
  const g  = document.createElementNS('http://www.w3.org/2000/svg', 'g');

  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', x); rect.setAttribute('y', y);
  rect.setAttribute('width', bw); rect.setAttribute('height', bh);
  rect.setAttribute('stroke', stroke);
  rect.setAttribute('stroke-width', isWall ? '2' : '1.5');
  rect.setAttribute('stroke-dasharray', isWall ? '' : '7,3');
  rect.setAttribute('fill', fill); rect.setAttribute('rx', '3');
  g.appendChild(rect);

  const txt = label.toUpperCase();
  const lh  = 19;
  const lw  = Math.min(txt.length * 6.2 + 14, bw + 6);
  const lx  = x;
  const ly  = y > lh + 2 ? y - lh - 2 : y + 2;

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', lx); bg.setAttribute('y', ly);
  bg.setAttribute('width', lw); bg.setAttribute('height', lh);
  bg.setAttribute('fill', stroke); bg.setAttribute('rx', '3');
  g.appendChild(bg);

  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.setAttribute('x', lx + 7); t.setAttribute('y', ly + 13);
  t.setAttribute('fill', '#fff'); t.setAttribute('font-size', '9.5');
  t.setAttribute('font-family', 'Space Mono, monospace');
  t.setAttribute('font-weight', '700'); t.setAttribute('text-anchor', 'start');
  t.textContent = txt;
  g.appendChild(t);
  annoSVG.appendChild(g);
}

/* ════════════════════════════════════════════════
   UTILS
════════════════════════════════════════════════ */
function hexToRgb(hex) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1],16), g: parseInt(r[2],16), b: parseInt(r[3],16) } : null;
}

function setStatus(html) {
  document.getElementById('status-txt').innerHTML = html;
}

/* resize → re-layout canvas */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!imgLoaded) return;
    const W    = mainC.width, H = mainC.height;
    // We need to re-calculate the display size based on new window size
    const pad  = 40;
    const maxW = zone.clientWidth  - pad;
    const maxH = zone.clientHeight - pad;
    const ratio = Math.min(maxW / W, maxH / H, 1);
    const displayW = Math.round(W * ratio);
    const displayH = Math.round(H * ratio);

    const offL = Math.round((zone.clientWidth  - displayW) / 2);
    const offT = Math.round((zone.clientHeight - displayH) / 2);

    [mainC, paintC, document.getElementById('overlay-canvas')].forEach(c => {
      c.style.width  = displayW + 'px';
      c.style.height = displayH + 'px';
      c.style.left   = offL + 'px';
      c.style.top    = offT + 'px';
    });
    annoSVG.style.width  = displayW + 'px';
    annoSVG.style.height = displayH + 'px';
    annoSVG.style.left   = offL + 'px';
    annoSVG.style.top    = offT + 'px';
    // Keep viewBox in sync with internal canvas resolution so AI boxes don't drift
    annoSVG.setAttribute('viewBox', `0 0 ${W} ${H}`);
    annoSVG.setAttribute('width',  W);
    annoSVG.setAttribute('height', H);
    if (typeof baActive !== 'undefined' && baActive) syncBASliderLayout();
  }, 120);
});

setTool('fill');
updateUndoRedoBtns(); // both disabled until a fill/erase action is made

/* ════════════════════════════════════════════════
   ZOOM / PAN
════════════════════════════════════════════════ */
const canvasInner = document.getElementById('canvas-inner');

function applyZoomPan() {
  if (!canvasInner) return;
  canvasInner.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
  const lbl = document.getElementById('zoom-label');
  if (lbl) lbl.textContent = Math.round(zoomLevel * 100) + '%';
}

function zoomStep(factor, keepCenter = false) {
  const prev = zoomLevel;
  zoomLevel = Math.max(0.15, Math.min(8, zoomLevel * factor));
  if (!keepCenter) {
    // Scale pan to keep canvas centred
    panX *= zoomLevel / prev;
    panY *= zoomLevel / prev;
  }
  applyZoomPan();
}

function zoomReset() {
  zoomLevel = 1; panX = 0; panY = 0;
  applyZoomPan();
}

/* ════════════════════════════════════════════════
   LIGHT / DARK THEME TOGGLE
════════════════════════════════════════════════ */
function toggleTheme() {
  document.body.classList.toggle('light');
  const btn = document.getElementById('btn-theme');
  const isLight = document.body.classList.contains('light');
  if (btn) btn.textContent = isLight ? '🌙' : '☀';
}

/* ════════════════════════════════════════════════
   FULLSCREEN
════════════════════════════════════════════════ */
function toggleFullscreen() {
  const shell = document.querySelector('.shell');
  shell.classList.toggle('fullscreen');
  const btn = document.getElementById('btn-fs');
  if (btn) btn.textContent = shell.classList.contains('fullscreen') ? '⛶' : '⛶';
  // Recalculate canvas layout after panel hides/shows
  setTimeout(() => {
    if (imgLoaded) {
      const W = mainC.width, H = mainC.height;
      const pad = 40;
      const maxW = zone.clientWidth  - pad;
      const maxH = zone.clientHeight - pad;
      const ratio = Math.min(maxW / W, maxH / H, 1);
      const displayW = Math.round(W * ratio);
      const displayH = Math.round(H * ratio);
      const offL = Math.round((zone.clientWidth  - displayW) / 2);
      const offT = Math.round((zone.clientHeight - displayH) / 2);
      [mainC, paintC, document.getElementById('overlay-canvas')].forEach(c => {
        c.style.width = displayW + 'px'; c.style.height = displayH + 'px';
        c.style.left  = offL + 'px';    c.style.top    = offT + 'px';
      });
      annoSVG.style.cssText += `width:${displayW}px;height:${displayH}px;left:${offL}px;top:${offT}px`;
      if (baActive) syncBASliderLayout();
    }
  }, 50);
}
// Also exit our custom fullscreen on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const shell = document.querySelector('.shell');
    if (shell.classList.contains('fullscreen')) shell.classList.remove('fullscreen');
  }
});

/* ════════════════════════════════════════════════
   KEYBOARD SHORTCUTS OVERLAY
════════════════════════════════════════════════ */
function toggleShortcuts() {
  const ov = document.getElementById('shortcuts-overlay');
  if (ov) ov.classList.toggle('open');
}
// Close on Escape (if not fullscreen)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const ov = document.getElementById('shortcuts-overlay');
    if (ov && ov.classList.contains('open')) { ov.classList.remove('open'); }
  }
});
