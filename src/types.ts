/** Un registro de documento extraído de una fila de la tabla de resultados. */
export interface DocumentRecord {
  /** Índice de fila dentro de la página (0-based), útil para depuración. */
  rowIndex: number;
  /** Número de página (1-based) en la que se encontró la fila. */
  page: number;
  /** Columnas de la tabla tal como aparecen en el sitio, ya limpias de espacios. */
  fields: Record<string, string>;
  /** Parámetros extra necesarios para reproducir el POST de descarga del PDF (si la fila tiene uno). */
  pdfDownload?: {
    extraParams: Record<string, string>;
  };
}

/** Resultado de descargar (o intentar descargar) el PDF de un documento. */
export interface DownloadResult {
  record: DocumentRecord;
  fileName: string;
  status: "ok" | "failed" | "skipped";
  error?: string;
  attempts: number;
}

export interface SiteOptions {
  /** Nombre corto usado para logs y nombres de archivo de salida. */
  key: string;
  /** URL completa de la página de resultados a scrapear. */
  url: string;
}
