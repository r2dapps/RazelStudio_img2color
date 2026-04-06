/**
 * sam.worker.js — MobileSAM inference worker
 * Runs entirely off the main thread.
 *
 * Message protocol (main → worker):
 *   { type:'load' }
 *     → loads ONNX Runtime + MobileSAM encoder + decoder
 *   { type:'encode', imageData: ImageData }
 *     → runs the image encoder, caches embedding
 *   { type:'decode', x, y, W, H }
 *     → runs the mask decoder for the given click point
 *
 * Message protocol (worker → main):
 *   { type:'progress', text, pct }
 *   { type:'ready' }          — models loaded OK
 *   { type:'encoded' }        — image embedding done
 *   { type:'mask', data: Uint8Array, W, H }  — decoded mask
 *   { type:'error', message } — any failure
 */

/* ── globals ──────────────────────────────────── */
let ortNamespace = null;   // onnxruntime-web namespace
let encSess   = null;   // encoder InferenceSession
let decSess   = null;   // decoder InferenceSession
let embedding = null;   // Float32Array [1,256,64,64]
let origW = 0, origH = 0; // size of the image that was encoded

/* ── CDN URLs ─────────────────────────────────── */
// Use locally hosted ort.min.js (downloaded from CDN) — avoids network block issues
// Use locally hosted ort.min.js — avoids network block issues
const ORT_LOCAL = 'ort.min.js';
// MobileSAM weights hosted on HuggingFace (ONNX export)
const ENC_URL   = 'https://huggingface.co/gifty-so/shoppy-mobilesam/resolve/main/mobile_sam_encoder.onnx';
const DEC_URL   = 'https://huggingface.co/gifty-so/shoppy-mobilesam/resolve/main/mobile_sam_decoder.onnx';

/* ── SAM constants ────────────────────────────── */
const SAM_SIZE = 1024;   // encoder input resolution

/* ── helpers ──────────────────────────────────── */
function post(msg, transfer) { self.postMessage(msg, transfer); }

async function fetchWithProgress(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${label}`);
  const total = parseInt(res.headers.get('content-length') || '0');
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) post({ type:'progress', text: label, pct: Math.round(received/total*100) });
  }
  const blob = new Blob(chunks);
  return await blob.arrayBuffer();
}

/* ── resize keeping aspect ratio to SAM_SIZE ─── */
function resizeImageData(imageData, targetW, targetH) {
  // Use OffscreenCanvas for off-thread resize
  const src = new OffscreenCanvas(imageData.width, imageData.height);
  src.getContext('2d').putImageData(imageData, 0, 0);
  const dst = new OffscreenCanvas(targetW, targetH);
  dst.getContext('2d').drawImage(src, 0, 0, targetW, targetH);
  return dst.getContext('2d').getImageData(0, 0, targetW, targetH);
}

function imageDataToRGB(imageData, W, H) {
  // Returns Float32Array [3, H, W] normalised to ImageNet mean/std
  const MEAN = [123.675, 116.28,  103.53];
  const STD  = [58.395,  57.12,   57.375];
  const data = imageData.data;
  const out  = new Float32Array(3 * H * W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      out[0 * H * W + y * W + x] = (data[si]   - MEAN[0]) / STD[0];
      out[1 * H * W + y * W + x] = (data[si+1] - MEAN[1]) / STD[1];
      out[2 * H * W + y * W + x] = (data[si+2] - MEAN[2]) / STD[2];
    }
  }
  return out;
}

/* ════════════════════════════════════════════════
   LOAD
════════════════════════════════════════════════ */
async function load() {
  console.log('[SAM Worker] Loading starting...');
  try {
    post({ type:'progress', text:'Booting ONNX Runtime…', pct:0 });

    // Load locally hosted ORT runtime — no external CDN required
    console.log('[SAM Worker] Importing:', ORT_LOCAL);
    importScripts(ORT_LOCAL);
    
    if (!self.ort) {
        throw new Error('onnxruntime-web not found in self.ort after import');
    }

    ortNamespace = self.ort;
    console.log('[SAM Worker] ONNX runtime found!');
    
    ortNamespace.env.wasm.numThreads = 1;   // single-thread wasm inside worker
    ortNamespace.env.wasm.simd       = true;
    // Point WASM resolver to local files (same directory as sam.worker.js)
    ortNamespace.env.wasm.wasmPaths  = { 'ort-wasm-simd.wasm': './ort-wasm-simd.wasm', 'ort-wasm.wasm': './ort-wasm.wasm' };

    post({ type:'progress', text:'Loading encoder weights (≈9 MB)…', pct:5 });
    const encBuf = await fetchWithProgress(ENC_URL, 'Encoder');

    post({ type:'progress', text:'Loading decoder weights (≈4 MB)…', pct:55 });
    const decBuf = await fetchWithProgress(DEC_URL, 'Decoder');

    post({ type:'progress', text:'Warming up neural network…', pct:90 });
    const opts = { executionProviders: ['wasm'] };
    encSess = await ortNamespace.InferenceSession.create(encBuf, opts);
    decSess = await ortNamespace.InferenceSession.create(decBuf, opts);

    console.log('[SAM Worker] Sessions ready!');
    post({ type:'ready' });
  } catch(err) {
    console.error('[SAM Worker] Critical load failure:', err);
    post({ type:'error', message: err.message });
  }
}

/* ════════════════════════════════════════════════
   ENCODE  — run once per image
════════════════════════════════════════════════ */
async function encode(imageData) {
  try {
    origW = imageData.width;
    origH = imageData.height;

    // Compute SAM's padded square resize: longest side → SAM_SIZE
    const scale   = SAM_SIZE / Math.max(origW, origH);
    const resizeW = Math.round(origW * scale);
    const resizeH = Math.round(origH * scale);

    post({ type:'progress', text:'Resizing image…', pct:10 });
    const resized = resizeImageData(imageData, resizeW, resizeH);

    // Pad to SAM_SIZE × SAM_SIZE (right + bottom padding)
    const padded = new OffscreenCanvas(SAM_SIZE, SAM_SIZE);
    padded.getContext('2d').putImageData(resized, 0, 0);
    const paddedData = padded.getContext('2d').getImageData(0, 0, SAM_SIZE, SAM_SIZE);

    post({ type:'progress', text:'Running image encoder…', pct:30 });
    const rgb    = imageDataToRGB(paddedData, SAM_SIZE, SAM_SIZE);
    const tensor = new ortNamespace.Tensor('float32', rgb, [1, 3, SAM_SIZE, SAM_SIZE]);
    const result = await encSess.run({ image: tensor });

    // Cache embedding — key name may be 'image_embeddings' or first output
    const key = Object.keys(result)[0];
    embedding = result[key];

    post({ type:'encoded', resizeW, resizeH, scale });
  } catch(err) {
    post({ type:'error', message: 'Encode failed: ' + err.message });
  }
}

/* ════════════════════════════════════════════════
   DECODE  — run per click (Now supports MULTI-POINT)
════════════════════════════════════════════════ */
async function decode({ points, W, H }) {
  if (!embedding) { post({ type:'error', message:'No embedding — encode first' }); return; }
  try {
    // Map click (x,y) in original image space → SAM encoder space
    const scale   = SAM_SIZE / Math.max(origW, origH);
    
    // We construct arrays for multi-point inputs
    const numPoints = points.length + 1; // plus padding point
    const coordsArray = new Float32Array(numPoints * 2);
    const labelsArray = new Float32Array(numPoints);
    
    for(let i=0; i<points.length; i++) {
        coordsArray[i*2] = points[i].x * scale;
        coordsArray[i*2+1] = points[i].y * scale;
        labelsArray[i] = points[i].label; // 1 = Foreground, 0 or -1 = Background
    }
    // MobileSAM requires a padding point (0,0) with label -1 at the very end
    coordsArray[(numPoints-1)*2] = 0;
    coordsArray[(numPoints-1)*2+1] = 0;
    labelsArray[numPoints-1] = -1;

    // SAM decoder inputs
    const pointCoords = new ortNamespace.Tensor('float32', coordsArray, [1, numPoints, 2]);
    const pointLabels = new ortNamespace.Tensor('float32', labelsArray, [1, numPoints]);
    const maskInput   = new ortNamespace.Tensor('float32', new Float32Array(256 * 256),             [1, 1, 256, 256]);
    const hasMask     = new ortNamespace.Tensor('float32', new Float32Array([0]),                   [1]);
    const origSize    = new ortNamespace.Tensor('float32', new Float32Array([origH * scale, origW * scale]), [2]);

    const feeds = {
      image_embeddings:    embedding,
      point_coords:        pointCoords,
      point_labels:        pointLabels,
      mask_input:          maskInput,
      has_mask_input:      hasMask,
      orig_im_size:        origSize,
    };

    const result = await decSess.run(feeds);

    // 'masks' output: [1, 1, H, W] logits; >0 = foreground
    const masksKey  = Object.keys(result).find(k => k.includes('mask')) || Object.keys(result)[0];
    const logits    = result[masksKey].data;  // Float32Array
    const maskH     = result[masksKey].dims[2];
    const maskW     = result[masksKey].dims[3];

    // Threshold logits → binary mask at SAM resolution, then scale to origW×origH
    const sampledMask = new Uint8Array(origW * origH);
    const scaleX = maskW / origW;
    const scaleY = maskH / origH;

    for (let oy = 0; oy < origH; oy++) {
      for (let ox = 0; ox < origW; ox++) {
        const my = Math.min(maskH - 1, Math.round(oy * scaleY));
        const mx = Math.min(maskW - 1, Math.round(ox * scaleX));
        sampledMask[oy * origW + ox] = logits[my * maskW + mx] > 0 ? 1 : 0;
      }
    }

    post({ type:'mask', data: sampledMask, W: origW, H: origH }, [sampledMask.buffer]);
  } catch(err) {
    post({ type:'error', message: 'Decode failed: ' + err.message });
  }
}

/* ── Message dispatcher ──────────────────────── */
self.onmessage = ({ data }) => {
  switch (data.type) {
    case 'load':   load();                  break;
    case 'encode': encode(data.imageData);  break;
    case 'decode_multi': decode(data);      break;
  }
};
