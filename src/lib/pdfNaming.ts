import { createHash } from "crypto";
import { DocumentRecord } from "../types";

// Encabezados candidatos a identificador, en orden de prioridad. Un header que sea
// solo un contador de fila ("Nro.", "N°", "#") se descarta explícitamente: matchea
// palabras como "número" pero no debe confundirse con la columna de numeración.
const ROW_COUNTER_HEADER = /^(nro\.?|n[°º]|#)$/i;
const IDENTIFIER_PRIORITY = [/expediente/i, /resoluci[oó]n/i, /n[uú]mero/i];

/** Devuelve el valor de la columna cuyo encabezado mejor identifica al documento. */
function pickIdentifierField(fields: Record<string, string>): string | undefined {
  const entries = Object.entries(fields).filter(
    ([header, value]) => value.trim().length > 0 && !ROW_COUNTER_HEADER.test(header.trim())
  );

  for (const pattern of IDENTIFIER_PRIORITY) {
    const hit = entries.find(([header]) => pattern.test(header));
    if (hit) return hit[1];
  }
  return undefined;
}

function sanitize(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // quita acentos
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function shortHash(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 8);
}

/**
 * Construye un nombre de archivo descriptivo para el PDF de un registro.
 *
 * Dos documentos distintos pueden compartir el mismo "Número de expediente" (pasa en la
 * práctica: apelaciones sobre un mismo expediente). Por eso, además del identificador
 * legible, se agrega un sufijo corto derivado de los parámetros de descarga de la fila
 * (que sí son únicos por documento) para garantizar que nunca dos documentos distintos
 * terminen pisándose o saltándose por compartir nombre de archivo.
 */
export function buildPdfFileName(record: DocumentRecord): string {
  const identifier = pickIdentifierField(record.fields);
  const base = identifier ? sanitize(identifier) : "documento";
  const discriminator = record.pdfDownload
    ? shortHash(JSON.stringify(record.pdfDownload.extraParams))
    : shortHash(`pagina${record.page}_fila${record.rowIndex}`);
  return `${base || "documento"}_${discriminator}.pdf`;
}
