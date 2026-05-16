import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

type Source = { id: string; title: string; authority: string; category: string; url: string; xmlUrl?: string; notes?: string };
const root = new URL("..", import.meta.url).pathname;
const manifestPath = join(root, "sources", "legal-sources.json");
const outDir = join(root, "sources", "downloaded");
mkdirSync(outDir, { recursive: true });
const sources = JSON.parse(readFileSync(manifestPath, "utf8")) as Source[];
const now = new Date().toISOString();
const index: any[] = [];

function sha256(data: string | ArrayBuffer) {
  return createHash("sha256").update(typeof data === "string" ? data : Buffer.from(data)).digest("hex");
}
function safeName(id: string, ext: string) { return `${id.replace(/[^A-Z0-9._-]/gi, "_")}.${ext}`; }

for (const source of sources) {
  const url = source.xmlUrl ?? source.url;
  const res = await fetch(url, { headers: { "user-agent": "Rentemester legal source downloader/0.0.1" } });
  if (!res.ok) throw new Error(`${source.id}: ${res.status} ${res.statusText} from ${url}`);
  const body = await res.text();
  const ext = url.endsWith("/xml") ? "xml" : basename(new URL(url).pathname).includes("pdf") ? "pdf" : "html";
  const file = join(outDir, safeName(source.id, ext));
  writeFileSync(file, body);
  index.push({ ...source, downloadedAt: now, localPath: file, bytes: Buffer.byteLength(body), sha256: sha256(body) });
  console.log(`downloaded ${source.id} (${Buffer.byteLength(body)} bytes)`);
}
writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 2));
writeFileSync(join(outDir, "README.md"), `# Downloaded legal sources\n\nDownloaded at ${now}.\n\n` + index.map(s => `- ${s.id}: ${s.title} (${s.sha256})`).join("\n") + "\n");
