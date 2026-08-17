import fs from "fs";
import path from "path";
import { DocumentRecord } from "../types";

export interface CountCheck {
  extracted: number;
  reportedBySite: number | null;
  /** true si la corrida se limitó con --max-pages: el desajuste es esperado, no un fallo. */
  partialRun: boolean;
  match: boolean;
  difference: number;
}

export interface DuplicateCheck {
  totalIds: number;
  uniqueIds: number;
  duplicateIds: { id: string; count: number }[];
}

export interface NullCheck {
  /** % de registros con valor vacío/solo-espacios, por columna. */
  percentPerColumn: Record<string, number>;
}

export interface PdfValidityCheck {
  totalFiles: number;
  validPdfs: number;
  invalidFiles: { fileName: string; reason: string }[];
}

export interface SanityReport {
  count: CountCheck;
  duplicates: DuplicateCheck;
  nulls: NullCheck;
  pdfs: PdfValidityCheck;
}

/**
 * ID "canónico" de un registro para detectar duplicados: se prioriza el param_uuid
 * de la descarga (único por documento en el servidor) porque, a diferencia de columnas
 * como "Número de expediente", no puede repetirse legítimamente entre dos documentos
 * distintos (ver nota en pdfNaming.ts sobre expedientes con varias resoluciones).
 */
function getRecordId(record: DocumentRecord): string {
  const params = record.pdfDownload?.extraParams;
  if (params) {
    const uuidLike = Object.values(params).find((v) => /^[0-9a-f-]{20,}$/i.test(v));
    if (uuidLike) return uuidLike;
    return JSON.stringify(params);
  }
  return `sin-descarga:pagina${record.page}:fila${record.rowIndex}`;
}

/** 1) Compara cuántos registros se extrajeron contra el total que reportó el sitio.
 * Si la corrida fue parcial (--max-pages), el desajuste es esperado y no cuenta como fallo. */
export function checkCount(
  records: DocumentRecord[],
  reportedBySite: number | null,
  partialRun: boolean
): CountCheck {
  const extracted = records.length;
  const difference = reportedBySite === null ? 0 : extracted - reportedBySite;
  return {
    extracted,
    reportedBySite,
    partialRun,
    match: partialRun || reportedBySite === null ? true : difference === 0,
    difference,
  };
}

/** 2) Busca IDs de documento repetidos entre los registros extraídos. */
export function checkDuplicates(records: DocumentRecord[]): DuplicateCheck {
  const counts = new Map<string, number>();
  for (const record of records) {
    const id = getRecordId(record);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const duplicateIds = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }));

  return { totalIds: records.length, uniqueIds: counts.size, duplicateIds };
}

/** 3) % de registros con valor vacío por cada columna detectada en el sitio. */
export function checkNulls(records: DocumentRecord[]): NullCheck {
  const columns = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record.fields)) columns.add(key);
  }

  const percentPerColumn: Record<string, number> = {};
  for (const column of columns) {
    const emptyCount = records.filter((r) => !(r.fields[column] ?? "").trim()).length;
    percentPerColumn[column] = records.length === 0 ? 0 : (emptyCount / records.length) * 100;
  }

  return { percentPerColumn };
}

const PDF_MAGIC = Buffer.from("%PDF-");

/** 4) Confirma que cada archivo .pdf descargado sea realmente un PDF (magic bytes), no
 * una página de error HTML guardada con extensión .pdf por accidente. */
export function checkPdfsAreValid(pdfDir: string): PdfValidityCheck {
  if (!fs.existsSync(pdfDir)) {
    return { totalFiles: 0, validPdfs: 0, invalidFiles: [] };
  }

  const files = fs.readdirSync(pdfDir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  const invalidFiles: { fileName: string; reason: string }[] = [];
  let validPdfs = 0;

  for (const fileName of files) {
    const filePath = path.join(pdfDir, fileName);
    const stat = fs.statSync(filePath);
    if (stat.size < 100) {
      invalidFiles.push({ fileName, reason: `archivo demasiado chico (${stat.size} bytes)` });
      continue;
    }

    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(5);
    fs.readSync(fd, header, 0, 5, 0);
    fs.closeSync(fd);

    if (!header.equals(PDF_MAGIC)) {
      invalidFiles.push({
        fileName,
        reason: `no empieza con la firma %PDF- (empieza con "${header.toString("utf-8")}")`,
      });
      continue;
    }

    validPdfs++;
  }

  return { totalFiles: files.length, validPdfs, invalidFiles };
}

export function runSanityChecks(
  records: DocumentRecord[],
  reportedBySite: number | null,
  partialRun: boolean,
  pdfDir: string
): SanityReport {
  return {
    count: checkCount(records, reportedBySite, partialRun),
    duplicates: checkDuplicates(records),
    nulls: checkNulls(records),
    pdfs: checkPdfsAreValid(pdfDir),
  };
}

export function formatSanityReport(report: SanityReport): string {
  const lines: string[] = [];
  lines.push("=== Sanity checks ===");

  const c = report.count;
  const countStatus = c.partialRun ? "INFORMATIVO (corrida parcial, --max-pages)" : c.match ? "OK" : "DESAJUSTE";
  lines.push(
    `1. Conteo: ${c.extracted} extraídos${
      c.reportedBySite !== null ? ` / ${c.reportedBySite} reportados por el sitio` : ""
    } — ${countStatus}${!c.partialRun && !c.match ? ` (diferencia: ${c.difference})` : ""}`
  );

  const d = report.duplicates;
  lines.push(
    `2. Duplicados por ID: ${d.duplicateIds.length} ID(s) repetido(s) de ${d.totalIds} registros (${d.uniqueIds} únicos) — ${
      d.duplicateIds.length === 0 ? "OK" : "REVISAR"
    }`
  );
  for (const dup of d.duplicateIds.slice(0, 10)) {
    lines.push(`   - "${dup.id}" aparece ${dup.count} veces`);
  }

  lines.push("3. % de nulos por columna:");
  for (const [column, pct] of Object.entries(report.nulls.percentPerColumn)) {
    lines.push(`   - ${column}: ${pct.toFixed(2)}%`);
  }

  const p = report.pdfs;
  lines.push(
    `4. PDFs válidos: ${p.validPdfs}/${p.totalFiles} — ${
      p.invalidFiles.length === 0 ? "OK" : "REVISAR"
    }`
  );
  for (const invalid of p.invalidFiles.slice(0, 10)) {
    lines.push(`   - ${invalid.fileName}: ${invalid.reason}`);
  }

  return lines.join("\n");
}
