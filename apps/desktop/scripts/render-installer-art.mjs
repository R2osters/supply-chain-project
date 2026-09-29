// Renders the installer artwork (installer/*.html) to the BMP files NSIS needs.
// Uses the Edge that ships with Windows in headless mode, then converts PNG → 24-bit BMP with a
// tiny encoder below, so no image library is needed. Run after changing the HTML or the version:
//   node scripts/render-installer-art.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { DESKTOP_DIR, isMain } from './lib/fetch.mjs';

const ART = [
  { html: 'sidebar.html', bmp: 'sidebar.bmp', width: 328, height: 628 },
  { html: 'header.html', bmp: 'header.bmp', width: 300, height: 114 },
];

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

export async function renderInstallerArt() {
  const edge = EDGE_CANDIDATES.find(existsSync);
  if (!edge) throw new Error('Microsoft Edge not found; it is needed to render the installer artwork');
  const version = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')).version;
  const dir = join(DESKTOP_DIR, 'installer');

  for (const art of ART) {
    const html = readFileSync(join(dir, art.html), 'utf8').replaceAll('__VERSION__', version);
    const page = join(tmpdir(), `scip-${art.html}`);
    const png = join(tmpdir(), `scip-${art.bmp}.png`);
    writeFileSync(page, html);
    execFileSync(edge, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      // Web fonts load from Google Fonts; give them time before the capture.
      '--virtual-time-budget=5000',
      `--window-size=${art.width},${art.height}`,
      `--screenshot=${png}`,
      pathToFileURL(page).href,
    ], { stdio: 'ignore' });
    writeFileSync(join(dir, art.bmp), pngToBmp(readFileSync(png)));
    rmSync(page, { force: true });
    rmSync(png, { force: true });
    console.log(`  ${art.bmp} ${art.width}x${art.height}`);
  }
}

/** Decodes an 8-bit RGB/RGBA non-interlaced PNG (what Chromium writes) into a 24-bit BMP. */
export function pngToBmp(png) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('Only 8-bit, non-interlaced PNG is supported');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }

  // BMP rows are bottom-up, BGR, padded to 4 bytes.
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const bmp = Buffer.alloc(54 + rowSize * height);
  bmp.write('BM', 0);
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(rowSize * height, 34);
  for (let y = 0; y < height; y++) {
    const target = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const source = y * stride + x * channels;
      bmp[target + x * 3] = pixels[source + 2];
      bmp[target + x * 3 + 1] = pixels[source + 1];
      bmp[target + x * 3 + 2] = pixels[source];
    }
  }
  return bmp;
}

if (isMain(import.meta.url)) {
  await renderInstallerArt();
}
