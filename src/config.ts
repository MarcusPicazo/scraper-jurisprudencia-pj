import path from "path";
import { SiteOptions } from "./types";

/** Sitios soportados. "pj" es el objetivo real del desafío; "oefa" es el sitio
 * alternativo sin VPN usado para desarrollo y pruebas (ambos son portales JSF/PrimeFaces). */
export const SITES: Record<string, SiteOptions> = {
  pj: {
    key: "pj",
    url: "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml",
  },
  oefa: {
    key: "oefa",
    url: "https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml",
  },
};

export const DEFAULT_SITE = "pj";

export const PATHS = {
  root: path.resolve(__dirname, ".."),
  dataDir: path.resolve(__dirname, "..", "data"),
  jsonDir: path.resolve(__dirname, "..", "data", "json"),
  pdfDir: path.resolve(__dirname, "..", "data", "pdfs"),
  logDir: path.resolve(__dirname, "..", "data", "logs"),
};

export const SCRAPER_CONFIG = {
  /** Pausa base entre requests para no sobrecargar el servidor (ms). */
  delayBetweenRequestsMs: 800,
  /** Pausa base entre descargas de PDF (ms). */
  delayBetweenDownloadsMs: 1200,
  /** Reintentos máximos ante un 429 antes de marcar el documento como fallido. */
  maxRetries: 5,
  /** Backoff exponencial: base * 2^intento, con jitter aleatorio. */
  backoffBaseMs: 1000,
  backoffMaxMs: 30_000,
  /** User-Agent de un navegador real; algunos WAF de gob.pe bloquean clientes sin UA. */
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  requestTimeoutMs: 30_000,
};
