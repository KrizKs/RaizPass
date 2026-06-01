import fs from "node:fs/promises";

globalThis.DOMMatrix = class DOMMatrix {
  constructor() {
    this.a = 1;
    this.b = 0;
    this.c = 0;
    this.d = 1;
    this.e = 0;
    this.f = 0;
  }
};
globalThis.ImageData = class ImageData {};
globalThis.Path2D = class Path2D {};

const { getDocument } = await import("file:///C:/Users/aaron/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pdfjs-dist/legacy/build/pdf.mjs");

const [input, output, maxPagesArg] = process.argv.slice(2);
const maxPages = Number(maxPagesArg || 30);

if (!input || !output) {
  console.error("Usage: node tools/extract-pdf-text.mjs <input.pdf> <output.txt> [maxPages]");
  process.exit(1);
}

const data = new Uint8Array(await fs.readFile(input));
const doc = await getDocument({ data, disableWorker: true }).promise;
let text = `PAGES ${doc.numPages}\n`;

for (let pageNumber = 1; pageNumber <= Math.min(doc.numPages, maxPages); pageNumber += 1) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const pageText = content.items.map((item) => item.str).join(" ");
  text += `\n--- PAGE ${pageNumber} ---\n${pageText}\n`;
}

await fs.writeFile(output, text, "utf8");
