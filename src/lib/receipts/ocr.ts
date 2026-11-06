import { createRequire } from "node:module";
import path from "node:path";

/**
 * Local OCR for receipt photos and scanned PDFs (Tesseract, in-process, using
 * the English model bundled in node_modules; nothing leaves the machine).
 * Used only to get text for matching hints; a vision model still reads items.
 */

type OcrWorker = {
  recognize: (img: Buffer) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
};

const IDLE_MS = 60_000;
let worker: Promise<OcrWorker> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
// Tesseract workers handle one image at a time.
let queue: Promise<unknown> = Promise.resolve();

/** png, jpeg or webp by magic bytes; Tesseract raises an uncatchable error on anything else. */
export function looksLikeImage(b: Buffer): boolean {
  if (b.length < 12) return false;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const webp = b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
  return png || jpeg || webp;
}

/**
 * In the Docker image the OCR packages live in their own flat node_modules
 * (OCR_MODULES_DIR); everywhere else they resolve normally.
 */
function modulesDir(): string | null {
  return process.env.OCR_MODULES_DIR ?? null;
}

export async function loadTesseract(): Promise<typeof import("tesseract.js")> {
  const dir = modulesDir();
  if (dir) return createRequire(path.join(dir, "x.js"))("tesseract.js");
  return import("tesseract.js");
}

export async function loadCanvas(): Promise<typeof import("@napi-rs/canvas")> {
  const dir = modulesDir();
  if (dir) return createRequire(path.join(dir, "x.js"))("@napi-rs/canvas");
  return import("@napi-rs/canvas");
}

function langPath(): string {
  const base = modulesDir() ?? process.cwd();
  return process.env.OCR_LANG_PATH ?? path.join(base, "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");
}

async function getWorker(): Promise<OcrWorker> {
  if (!worker) {
    worker = loadTesseract().then(
      ({ createWorker }) =>
        createWorker("eng", 1, { langPath: langPath(), gzip: true, cachePath: path.join(process.env.TMPDIR ?? "/tmp", "ledgr-ocr"),
          // A bad image makes the worker emit an error event; without a handler that
          // is an uncaught exception that takes the whole server down.
          errorHandler: (e: unknown) => console.error("[receipts] OCR worker error", e),
        }) as Promise<OcrWorker>,
    );
    worker.catch(() => {
      worker = null;
    });
  }
  return worker;
}

function scheduleShutdown() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    const w = worker;
    worker = null;
    void w?.then((x) => x.terminate()).catch(() => undefined);
  }, IDLE_MS);
  idle.unref?.();
}

/** Text found in an image (png, jpg, webp), or "" if none. Never throws. */
export async function ocrImage(data: Buffer): Promise<string> {
  const run = queue.then(async () => {
    if (!looksLikeImage(data)) return "";
    try {
      const w = await getWorker();
      const { data: out } = await w.recognize(data);
      return out.text ?? "";
    } catch (e) {
      console.error("[receipts] OCR failed", e);
      return "";
    } finally {
      scheduleShutdown();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** First pages of a PDF as PNG images, for scanned documents with no text layer. */
export async function renderPdfPages(data: Buffer, maxPages = 3): Promise<Buffer[]> {
  try {
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const pages: Buffer[] = [];
    for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
      const png = await renderPageAsImage(pdf, n, {
        canvasImport: loadCanvas,
        scale: 2,
      });
      pages.push(Buffer.from(png as Uint8Array));
    }
    return pages;
  } catch (e) {
    console.error("[receipts] could not render PDF pages", e);
    return [];
  }
}

export async function ocrPdf(data: Buffer, maxPages = 3): Promise<string> {
  const texts: string[] = [];
  for (const page of await renderPdfPages(data, maxPages)) texts.push(await ocrImage(page));
  return texts.join("\n").trim();
}
