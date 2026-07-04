// Prepare a user-picked file for the scan-receipt API. Phone photos are huge
// (a 12MP shot is 3–8MB; base64 adds +33%), which blows past the serverless
// request-body limit and the vision API's 5MB/8000px image caps — the classic
// "the system couldn't scan it" on a receipt photographed with a phone.
// Receipts OCR perfectly at ~2000px, so images are downscaled and re-encoded
// as JPEG in the browser before upload. PDFs pass through untouched.
const MAX_DIM = 2000
const JPEG_QUALITY = 0.85
// Under this size an already-supported image is sent as-is (no quality loss).
const PASSTHROUGH_BYTES = 2_500_000
const API_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    img.src = url
  })
}

export async function fileForScan(file: File): Promise<{ base64: string; mediaType: string }> {
  if (file.type === 'application/pdf') {
    return { base64: await toBase64(file), mediaType: 'application/pdf' }
  }
  try {
    const img = await loadImage(file)
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    const scale = Math.min(1, MAX_DIM / Math.max(w, h))
    // Small enough AND in a format the API accepts → send the original bytes.
    if (scale === 1 && file.size <= PASSTHROUGH_BYTES && API_TYPES.includes(file.type)) {
      return { base64: await toBase64(file), mediaType: file.type }
    }
    // Downscale/re-encode (also converts exotic formats the browser can decode,
    // e.g. HEIC on Safari or BMP/TIFF, into API-supported JPEG).
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas 2d context')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    return { base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' }
  } catch {
    // Undecodable image (e.g. HEIC on Chrome) — fall back to the raw bytes so
    // the API can at least return its own clear unsupported-format error.
    return { base64: await toBase64(file), mediaType: file.type }
  }
}
