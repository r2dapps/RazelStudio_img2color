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

// ── History (Undo / Redo) ──────────────────────────────────────
const MAX_HISTORY = 20;
let undoStack = []; // each entry: Float32Array snapshot of maskData
let redoStack = [];

function saveHistory() {
  if (!maskData) return;
  undoStack.push(maskData.slice()); // clone
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  updateUndoRedoBtns();
}

function undo() {
  if (!undoStack.length || !imgLoaded) return;
  redoStack.push(maskData.slice());
  maskData = undoStack.pop();
  redrawPaint();
  drawProtectOverlay();
  updateUndoRedoBtns();
  setStatus('↩ <b>Undo</b>');
}

function redo() {
  if (!redoStack.length || !imgLoaded) return;
  undoStack.push(maskData.slice());
  maskData = redoStack.pop();
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
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); redo(); }
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
  const tol    = parseInt(document.getElementById('tol').value);
  const filled = floodFill(x, y, tol);
  redrawPaint();
  setStatus(`<b>Filled</b> ${filled.toLocaleString()} pixels`);
});

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
  if (curTool === 'protect') { isProtecting = true; applyProtectBrush(e); }
});
mainC.addEventListener('mousemove', e => {
  if (isErasing   && curTool === 'erase')   applyEraseBrush(e);
  if (isProtecting && curTool === 'protect') applyProtectBrush(e);
});
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

mainC.addEventListener('mousedown', e => {
  if (!imgLoaded) return;
  if (curTool === 'protect') { isProtecting = true; applyProtectBrush(e); }
});
mainC.addEventListener('mousemove', e => {
  if (curTool === 'protect' && isProtecting) applyProtectBrush(e);
});
window.addEventListener('mouseup', () => {
  if (isProtecting) {
    isProtecting = false;
    setStatus('<b>Protection applied</b> — now click walls to fill');
  }
});
mainC.addEventListener('touchstart', e => {
  if (!imgLoaded || curTool !== 'protect') return;
  e.preventDefault(); isProtecting = true; applyProtectBrush(e);
}, { passive: false });
mainC.addEventListener('touchmove', e => {
  if (!isProtecting || curTool !== 'protect') return;
  e.preventDefault(); applyProtectBrush(e);
}, { passive: false });
window.addEventListener('touchend', () => { isProtecting = false; });

function clearAll() {
  if (!imgLoaded) return;
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

    // Render shaded tile into an offscreen canvas
    const offC = new OffscreenCanvas(tileW, tileH);
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

    // Create tiling pattern
    const patCanvas = document.createElement('canvas');
    patCanvas.width = tileW; patCanvas.height = tileH;
    patCanvas.getContext('2d').drawImage(offC, 0, 0);
    const pat = paintX.createPattern(patCanvas, 'repeat');

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
  mainC.style.transform  = t;
  paintC.style.transform = t;
  document.getElementById('overlay-canvas').style.transform = t;
  annoSVG.style.transform = t;
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
  ['fill','erase','clear','protect'].forEach(k => {
    const b = document.getElementById('tbtn-' + k);
    if (b) b.classList.toggle('active', k === t);
  });
  mainC.style.cursor = (t === 'erase' || t === 'protect') ? 'cell' : 'crosshair';
}

/* ════════════════════════════════════════════════
   DOWNLOAD
════════════════════════════════════════════════ */
function downloadImage() {
  if (!imgLoaded) { alert('Upload a room photo first.'); return; }
  // Composite: draw original + paint layer on a fresh canvas
  const out  = document.createElement('canvas');
  out.width  = mainC.width;
  out.height = mainC.height;
  const ctx  = out.getContext('2d');
  ctx.drawImage(mainC,  0, 0); // room photo
  ctx.drawImage(paintC, 0, 0); // painted layer

  // Filename: ChromaWall_<ColorName>_<HEX>.png
  const name = (document.getElementById('cname')?.textContent || 'Custom').replace(/\s+/g, '-');
  const hex  = (document.getElementById('chex')?.textContent  || '#000000').replace('#', '');
  const filename = `ChromaWall_${name}_${hex}.png`;

  const a = document.createElement('a');
  a.href     = out.toDataURL('image/png');
  a.download = filename;
  a.click();
  setStatus(`⬇ <b>Saved</b> ${filename}`);
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
  }, 120);
});

setTool('fill');
updateUndoRedoBtns(); // both disabled until a fill/erase action is made
