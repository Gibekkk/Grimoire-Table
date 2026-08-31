// Compresses an image file into a base64 data URL small enough to store directly
// in a Firestore field, since this project intentionally avoids Firebase Storage
// (not available on the free Spark plan's typical setup). Iteratively lowers
// quality and then dimensions until the result fits the target byte budget.

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function drawToCanvas(img, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#1a1b26"; // flatten transparency onto the app's ink background
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

// options: { maxDim, targetBytes, minQuality }
// Returns { dataUrl, width, height, approxBytes }
export async function compressImageToBase64(file, options = {}) {
  const { maxDim = 512, targetBytes = 220000, minQuality = 0.35 } = options;
  const img = await loadImage(file);

  let dim = maxDim;
  let quality = 0.82;
  let dataUrl = "";

  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = drawToCanvas(img, dim);
    dataUrl = canvas.toDataURL("image/jpeg", quality);
    const approxBytes = Math.round(dataUrl.length * 0.75); // base64 ~4/3 expansion
    if (approxBytes <= targetBytes || (quality <= minQuality && dim <= 128)) {
      return { dataUrl, width: canvas.width, height: canvas.height, approxBytes };
    }
    if (quality > minQuality) quality = Math.max(minQuality, quality - 0.15);
    else dim = Math.round(dim * 0.75);
  }
  const approxBytes = Math.round(dataUrl.length * 0.75);
  return { dataUrl, width: 0, height: 0, approxBytes };
}

// Presets used across the app so every image type gets a sane, consistent budget.
export const IMAGE_PRESETS = {
  portrait: { maxDim: 320, targetBytes: 120000 },       // character/NPC headshots
  token: { maxDim: 128, targetBytes: 40000 },            // small map token art (falls back to portrait)
  mapBackground: { maxDim: 1400, targetBytes: 700000 },  // battle maps — the big one
  component: { maxDim: 256, targetBytes: 90000 }         // furniture/props
};

export function fileInputToCompressed(inputEl, preset) {
  return new Promise((resolve, reject) => {
    const file = inputEl.files?.[0];
    if (!file) { resolve(null); return; }
    compressImageToBase64(file, IMAGE_PRESETS[preset] || {}).then(resolve).catch(reject);
  });
}
