import fs from "fs";
import path from "path";
import { JsfSession } from "./lib/jsfSession";
import { Logger } from "./lib/logger";
import { withRetry429 } from "./lib/retry";
import { sleep, withJitter } from "./lib/sleep";
import { buildPdfFileName } from "./lib/pdfNaming";
import { PATHS, SCRAPER_CONFIG } from "./config";
import { DocumentRecord, DownloadResult } from "./types";

export interface ScrapeOptions {
  siteKey: string;
  url: string;
  /** Límite de páginas a recorrer (para pruebas rápidas). Por defecto, todas. */
  maxPages?: number;
  /** Si es true, descarga los PDFs de cada documento a medida que se van encontrando. */
  downloadPdfs: boolean;
  /** Límite de descargas de PDF (para pruebas rápidas). Por defecto, todas. */
  maxDownloads?: number;
}

interface FailedDownloadEntry {
  fields: Record<string, string>;
  extraParams: Record<string, string>;
  fileName: string;
}

function ensureDirs(siteKey: string) {
  fs.mkdirSync(PATHS.jsonDir, { recursive: true });
  fs.mkdirSync(path.join(PATHS.pdfDir, siteKey), { recursive: true });
  fs.mkdirSync(PATHS.logDir, { recursive: true });
}

function runTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Recorre todo el sitio (búsqueda + paginación), extrayendo todos los documentos.
 * Devuelve también la sesión usada, para poder reutilizarla al descargar los PDFs
 * (comparte cookies y ViewState con la última página visitada).
 *
 * El JSON de salida se reescribe en disco después de cada página (no solo al final):
 * así, si el proceso se interrumpe o se cae a mitad de una corrida larga (el sitio
 * real tiene 176 páginas), lo ya extraído queda guardado en vez de perderse. */
export async function scrapeAllPages(
  opts: ScrapeOptions,
  logger: Logger
): Promise<{
  records: DocumentRecord[];
  session: JsfSession;
  jsonPath: string;
  totalRecordsReported: number | null;
  partialRun: boolean;
}> {
  const jsonPath = getRunJsonPath(opts.siteKey);

  const session = new JsfSession(opts.url, logger);
  await withRetry429(() => session.init(), { label: "carga inicial de la página", logger });

  logger.info(`Enviando búsqueda inicial (sin filtros = todos los registros)...`);
  const first = await withRetry429(() => session.search(), {
    label: "búsqueda inicial",
    logger,
  });
  const allRecords: DocumentRecord[] = [...first.records];
  writeRecordsJson(jsonPath, allRecords);

  if (!first.pagination) {
    logger.warn(
      "No se detectó información de paginación estándar; se asume que todos los resultados están en una sola página."
    );
    return {
      records: allRecords,
      session,
      jsonPath,
      totalRecordsReported: null,
      partialRun: false,
    };
  }

  const { totalPages, totalRecords } = first.pagination;
  logger.info(
    `Total: ${totalRecords} registros en ${totalPages} páginas (${session.rowsPerPage} filas/página).`
  );

  const partialRun = opts.maxPages !== undefined && opts.maxPages < totalPages;
  const lastPage = opts.maxPages !== undefined ? Math.min(opts.maxPages, totalPages) : totalPages;

  for (let page = 2; page <= lastPage; page++) {
    await sleep(withJitter(SCRAPER_CONFIG.delayBetweenRequestsMs));
    logger.info(`Obteniendo página ${page}/${lastPage}...`);

    try {
      const result = await withRetry429(() => session.goToPage(page), {
        label: `página ${page}`,
        logger,
      });
      allRecords.push(...result.records);
      writeRecordsJson(jsonPath, allRecords);
    } catch (err) {
      logger.error(
        `No se pudo obtener la página ${page} tras los reintentos: ${(err as Error).message}. Se continúa con la siguiente.`
      );
    }
  }

  return {
    records: allRecords,
    session,
    jsonPath,
    totalRecordsReported: totalRecords,
    partialRun,
  };
}

/** Descarga los PDFs asociados a los registros que tengan info de descarga disponible. */
export async function downloadPdfs(
  session: JsfSession,
  records: DocumentRecord[],
  opts: ScrapeOptions,
  logger: Logger
): Promise<DownloadResult[]> {
  const outDir = path.join(PATHS.pdfDir, opts.siteKey);
  fs.mkdirSync(outDir, { recursive: true });

  const downloadable = records.filter((r) => r.pdfDownload);
  const limit =
    opts.maxDownloads !== undefined
      ? Math.min(opts.maxDownloads, downloadable.length)
      : downloadable.length;

  logger.info(`Descargando ${limit}/${downloadable.length} PDFs disponibles...`);

  const results: DownloadResult[] = [];
  const failed: FailedDownloadEntry[] = [];

  for (let i = 0; i < limit; i++) {
    const record = downloadable[i];
    const fileName = buildPdfFileName(record);
    const filePath = path.join(outDir, fileName);

    if (fs.existsSync(filePath)) {
      logger.info(`[${i + 1}/${limit}] Ya existe, se omite: ${fileName}`);
      results.push({ record, fileName, status: "skipped", attempts: 0 });
      continue;
    }

    await sleep(withJitter(SCRAPER_CONFIG.delayBetweenDownloadsMs));

    let attempts = 0;
    try {
      const { data } = await withRetry429(
        () => {
          attempts++;
          return session.downloadRow(record.pdfDownload!.extraParams);
        },
        { label: `descarga "${fileName}"`, logger }
      );
      fs.writeFileSync(filePath, data);
      logger.info(`[${i + 1}/${limit}] Descargado: ${fileName} (${data.length} bytes)`);
      results.push({ record, fileName, status: "ok", attempts });
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`[${i + 1}/${limit}] Falló "${fileName}" tras ${attempts} intento(s): ${message}`);
      results.push({ record, fileName, status: "failed", attempts, error: message });
      failed.push({
        fields: record.fields,
        extraParams: record.pdfDownload!.extraParams,
        fileName,
      });
    }
  }

  if (failed.length > 0) {
    const failedPath = path.join(PATHS.logDir, `failed-${opts.siteKey}.json`);
    fs.writeFileSync(failedPath, JSON.stringify(failed, null, 2), "utf-8");
    logger.warn(`${failed.length} descargas fallidas registradas en ${failedPath} para reintentar luego.`);
  }

  return results;
}

/** Reintenta las descargas previamente fallidas, guardadas en data/logs/failed-<site>.json. */
export async function retryFailedDownloads(
  opts: ScrapeOptions,
  logger: Logger
): Promise<DownloadResult[]> {
  const failedPath = path.join(PATHS.logDir, `failed-${opts.siteKey}.json`);
  if (!fs.existsSync(failedPath)) {
    logger.info(`No hay descargas fallidas registradas para "${opts.siteKey}".`);
    return [];
  }

  const failedEntries: FailedDownloadEntry[] = JSON.parse(fs.readFileSync(failedPath, "utf-8"));
  logger.info(`Reintentando ${failedEntries.length} descargas fallidas...`);

  const session = new JsfSession(opts.url, logger);
  await withRetry429(() => session.init(), { label: "carga inicial de la página", logger });
  await withRetry429(() => session.search(), { label: "búsqueda inicial", logger }); // reconstituye una sesión/ViewState válidos

  const records: DocumentRecord[] = failedEntries.map((e, idx) => ({
    rowIndex: idx,
    page: 0,
    fields: e.fields,
    pdfDownload: { extraParams: e.extraParams },
  }));

  const results = await downloadPdfs(session, records, opts, logger);

  const stillFailed = results.filter((r) => r.status === "failed");
  if (stillFailed.length === 0 && failedEntries.length > 0) {
    fs.unlinkSync(failedPath);
    logger.info("Todas las descargas pendientes se completaron; se limpió el registro de fallidas.");
  }

  return results;
}

function getRunJsonPath(siteKey: string): string {
  fs.mkdirSync(PATHS.jsonDir, { recursive: true });
  return path.join(PATHS.jsonDir, `${siteKey}-${runTimestamp()}.json`);
}

function writeRecordsJson(filePath: string, records: DocumentRecord[]): void {
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), "utf-8");
}

export { ensureDirs };
