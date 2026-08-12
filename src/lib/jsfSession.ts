import * as cheerio from "cheerio";
import qs from "querystring";
import { createHttpClient, HttpClient } from "./httpClient";
import {
  DiscoveredTable,
  FormState,
  discoverForm,
  discoverPagination,
  discoverSearchControl,
  discoverTable,
  extractRows,
  parsePartialResponse,
  PaginationInfo,
} from "./jsfParser";
import { DocumentRecord } from "../types";
import { Logger } from "./logger";

/**
 * Encapsula una "sesión" de scraping contra un portal JSF/PrimeFaces:
 * - mantiene cookies (JSESSIONID) y el estado del formulario (incluido el ViewState,
 *   que el servidor rota en cada respuesta cuando usa server-side state saving).
 * - sabe reproducir los 3 tipos de request que usan estos portales:
 *     1) GET inicial de la página
 *     2) POST ajax (javax.faces.partial.ajax=true) para búsqueda y paginación
 *     3) POST "clásico" (form submit completo) para descargar archivos, al estilo
 *        mojarra.jsfcljs()
 */
export class JsfSession {
  private client: HttpClient;
  private url: string;
  private logger: Logger;

  formId!: string;
  fields!: FormState;
  table?: DiscoveredTable;
  searchControlId?: string;
  /** Tamaño de página del datatable, inferido a partir de la primera página de resultados. */
  rowsPerPage = 10;

  constructor(url: string, logger: Logger) {
    this.url = url;
    this.logger = logger;
    this.client = createHttpClient().client;
  }

  /** Carga la página inicial y descubre formulario, tabla y control de búsqueda. */
  async init(): Promise<void> {
    const res = await this.client.get<string>(this.url);
    const $ = cheerio.load(res.data);

    const form = discoverForm($);
    this.formId = form.formId;
    this.fields = form.fields;
    this.table = discoverTable($, this.formId);
    this.searchControlId = discoverSearchControl($, this.formId);

    this.logger.info(
      `Formulario descubierto: "${this.formId}" | tabla: ${
        this.table ? this.table.dataTableId : "no encontrada aún (puede aparecer tras buscar)"
      } | control de búsqueda: ${this.searchControlId ?? "no encontrado"}`
    );
  }

  /** Ejecuta el submit de búsqueda (equivalente a click en "Buscar") sin filtros = trae todo. */
  async search(): Promise<{ records: DocumentRecord[]; pagination?: PaginationInfo }> {
    if (!this.searchControlId) {
      throw new Error(
        "No se encontró el botón de búsqueda del formulario; no se puede continuar."
      );
    }

    const body = {
      ...this.fields,
      "javax.faces.partial.ajax": "true",
      "javax.faces.source": this.searchControlId,
      "javax.faces.partial.execute": "@all",
      "javax.faces.partial.render": "@all",
      [this.searchControlId]: this.searchControlId,
    };

    const html = await this.postAjax(body);
    const result = this.parseResultsHtml(html, 1);
    if (result.records.length > 0) {
      // El tamaño de página real lo determina el propio servidor; lo inferimos de la
      // primera página (que siempre viene completa salvo que haya menos resultados en total).
      this.rowsPerPage = result.records.length;
    }
    return result;
  }

  /** Navega a una página del datatable reproduciendo el evento de paginación de PrimeFaces. */
  async goToPage(pageNumber: number): Promise<{
    records: DocumentRecord[];
    pagination?: PaginationInfo;
  }> {
    if (!this.table) {
      throw new Error("No hay tabla descubierta; corre search() primero.");
    }
    const dt = this.table.dataTableId;
    const rowsPerPage = this.rowsPerPage;
    const first = (pageNumber - 1) * rowsPerPage;

    const body = {
      ...this.fields,
      "javax.faces.partial.ajax": "true",
      "javax.faces.source": dt,
      "javax.faces.partial.execute": dt,
      "javax.faces.partial.render": dt,
      [dt]: dt,
      [`${dt}_pagination`]: "true",
      [`${dt}_first`]: String(first),
      [`${dt}_rows`]: String(rowsPerPage),
      [`${dt}_skipChildren`]: "true",
      [`${dt}_encodeFeature`]: "true",
      [`${dt}_scrollState`]: "0,0",
    };

    const html = await this.postAjax(body);
    return this.parseResultsHtml(html, pageNumber);
  }

  /**
   * Reproduce la descarga de un archivo asociado a una fila (patrón mojarra.jsfcljs):
   * un submit "clásico" del formulario con un par de campos extra que identifican la fila.
   * Devuelve el binario y el content-type reportado por el servidor.
   */
  async downloadRow(
    extraParams: Record<string, string>
  ): Promise<{ data: Buffer; contentType: string; contentDisposition?: string }> {
    const body = {
      ...this.fields,
      [this.formId]: this.formId,
      ...extraParams,
    };

    const res = await this.client.post(this.url, qs.stringify(body), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      responseType: "arraybuffer",
    });

    const contentType = String(res.headers["content-type"] ?? "");
    const buffer = Buffer.from(res.data);

    // Si el servidor devolvió HTML en vez de un binario, algo falló (ViewState expirado,
    // sesión inválida, error de servidor). Refrescamos el estado del form por si acaso y
    // dejamos que el llamador decida cómo tratar el fallo.
    if (contentType.includes("text/html")) {
      const $ = cheerio.load(buffer.toString("utf-8"));
      try {
        const form = discoverForm($);
        this.fields = form.fields;
      } catch {
        // si ni siquiera hay formulario JSF reconocible, dejamos el estado como estaba
      }
      throw new Error(
        `El servidor respondió HTML en vez de un archivo (posible sesión expirada o error).`
      );
    }

    return {
      data: buffer,
      contentType,
      contentDisposition: res.headers["content-disposition"],
    };
  }

  private async postAjax(body: Record<string, string>): Promise<string> {
    const res = await this.client.post<string>(this.url, qs.stringify(body), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Faces-Request": "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    return res.data;
  }

  /** Extrae filas + paginación de una respuesta (puede ser HTML completo o partial-response XML). */
  private parseResultsHtml(
    raw: string,
    page: number
  ): { records: DocumentRecord[]; pagination?: PaginationInfo } {
    const isPartial = raw.trimStart().startsWith("<?xml") || raw.includes("<partial-response");
    const html = isPartial ? this.mergePartialUpdates(raw) : raw;

    if (!this.table) {
      const $ = cheerio.load(html);
      this.table = discoverTable($, this.formId);
    }
    if (!this.table) {
      throw new Error("No se pudo localizar la tabla de resultados tras la búsqueda.");
    }

    const records = extractRows(html, this.table.dataTableId, this.table.columns, page);
    const $ = cheerio.load(`<div>${html}</div>`);
    const pagination = discoverPagination($, this.rowsPerPage);

    return { records, pagination };
  }

  /** Concatena todos los fragmentos <update> de una partial-response y refresca ViewState/campos. */
  private mergePartialUpdates(xml: string): string {
    const updates = parsePartialResponse(xml);
    let combined = "";
    for (const [, fragment] of updates) {
      combined += fragment + "\n";
    }

    // El ViewState viaja como uno de los fragmentos <update id="javax.faces.ViewState">
    // o embebido dentro de un <update> más grande; en ambos casos basta con re-parsear
    // el HTML combinado buscando el input.
    const $ = cheerio.load(`<div>${combined}</div>`);
    const newViewState = $('input[name="javax.faces.ViewState"]').attr("value");
    if (newViewState) {
      this.fields["javax.faces.ViewState"] = newViewState;
    }

    return combined;
  }
}
