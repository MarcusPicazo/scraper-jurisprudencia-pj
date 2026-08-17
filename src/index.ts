import fs from "fs";
import path from "path";
import { DEFAULT_SITE, PATHS, SITES } from "./config";
import { Logger } from "./lib/logger";
import { formatSanityReport, runSanityChecks } from "./lib/sanityChecks";
import { downloadPdfs, ensureDirs, retryFailedDownloads, scrapeAllPages } from "./scraper";

interface Cli {
  site: string;
  maxPages?: number;
  maxDownloads?: number;
  downloadPdfs: boolean;
  retryFailed: boolean;
}

/** Parsea "--flag=123" como entero no negativo; devuelve undefined (y avisa) si no es válido. */
function parseNonNegativeInt(raw: string, flagName: string): number | undefined {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`Valor inválido para ${flagName}: "${raw}" (se ignora, se usa el default).`);
    return undefined;
  }
  return n;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { site: DEFAULT_SITE, downloadPdfs: true, retryFailed: false };

  for (const arg of argv) {
    if (arg.startsWith("--site=")) cli.site = arg.split("=")[1];
    else if (arg.startsWith("--max-pages="))
      cli.maxPages = parseNonNegativeInt(arg.split("=")[1], "--max-pages");
    else if (arg.startsWith("--max-downloads="))
      cli.maxDownloads = parseNonNegativeInt(arg.split("=")[1], "--max-downloads");
    else if (arg === "--no-download-pdfs") cli.downloadPdfs = false;
    else if (arg === "--retry-failed") cli.retryFailed = true;
  }

  return cli;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const site = SITES[cli.site];
  if (!site) {
    console.error(
      `Sitio "${cli.site}" desconocido. Opciones válidas: ${Object.keys(SITES).join(", ")}`
    );
    process.exit(1);
  }

  ensureDirs(site.key);
  const logger = new Logger(`${site.key}-${cli.retryFailed ? "retry" : "run"}`);
  logger.info(`Sitio objetivo: ${site.key} (${site.url})`);

  const opts = {
    siteKey: site.key,
    url: site.url,
    maxPages: cli.maxPages,
    maxDownloads: cli.maxDownloads,
    downloadPdfs: cli.downloadPdfs,
  };

  if (cli.retryFailed) {
    const results = await retryFailedDownloads(opts, logger);
    const ok = results.filter((r) => r.status === "ok").length;
    logger.info(`Reintento terminado: ${ok}/${results.length} descargas recuperadas.`);
    return;
  }

  const { records, session, jsonPath, totalRecordsReported, partialRun } = await scrapeAllPages(
    opts,
    logger
  );
  logger.info(`${records.length} documentos extraídos. Guardados en ${jsonPath}`);

  if (cli.downloadPdfs) {
    const results = await downloadPdfs(session, records, opts, logger);
    const ok = results.filter((r) => r.status === "ok").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const failed = results.filter((r) => r.status === "failed").length;
    logger.info(`PDFs: ${ok} descargados, ${skipped} ya existían, ${failed} fallidos.`);
  } else {
    logger.info("Descarga de PDFs omitida (--no-download-pdfs).");
  }

  const pdfDir = path.join(PATHS.pdfDir, site.key);
  const report = runSanityChecks(records, totalRecordsReported, partialRun, pdfDir);
  logger.info("\n" + formatSanityReport(report));

  const reportPath = path.join(PATHS.logDir, `sanity-check-${site.key}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  logger.info(`Reporte de sanity checks guardado en ${reportPath}`);
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
