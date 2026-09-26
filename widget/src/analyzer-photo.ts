/**
 * Photo capture and downscaling.
 *
 * The full-resolution original never leaves the device: it is drawn into a
 * canvas at a bounded size and re-encoded as JPEG before upload. That keeps
 * the request comfortably inside the backend's body limit, makes the upload
 * fast on a phone connection, and means the biggest, most identifying copy
 * of the customer's face stays where it started.
 */

/** Long edge, in pixels. Plenty for judging shine, texture and curl pattern. */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.8;

export interface PreparedPhoto {
  /** `data:image/jpeg;base64,…`, ready to POST. */
  dataUrl: string;
  /** Object URL for the on-page preview; revoke it when done. */
  previewUrl: string;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const img = await loadImage(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process that image.');
  ctx.drawImage(img, 0, 0, width, height);

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return { dataUrl, previewUrl: dataUrl };
}
