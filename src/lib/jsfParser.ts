import * as cheerio from "cheerio";
import { DocumentRecord } from "../types";

/** Campos de un formulario JSF: nombre -> valor actual (incluye hidden inputs como el ViewState). */
export type FormState = Record<string, string>;

export interface DiscoveredForm {
  formId: string;
  fields: FormState;
}

export interface DiscoveredTable {
  /** clientId del datatable de PrimeFaces, p.ej. "miForm:dt". Se usa como prefijo de los
   * parámetros de paginación (`${dataTableId}_first`, `_rows`, etc). */
  dataTableId: string;
  columns: string[];
}

export interface PaginationInfo {
  currentPage: number;
  totalPages: number;
  totalRecords: number;
  rowsPerPage: number;
  hasNextPage: boolean;
}

/**
 * Encuentra el primer <form> que contenga un input javax.faces.ViewState: es la firma
 * de un formulario JSF, y normalmente es el único formulario "real" de la página.
 */
export function discoverForm($: cheerio.CheerioAPI): DiscoveredForm {
  let formId: string | undefined;
  let $form: ReturnType<cheerio.CheerioAPI> | undefined;

  $("form").each((_, el) => {
    const $el = $(el);
    if ($el.find('input[name="javax.faces.ViewState"]').length > 0) {
      formId = $el.attr("id") ?? $el.attr("name");
      $form = $el;
      return false; // rompe el .each
    }
    return undefined;
  });

  if (!formId || !$form) {
    throw new Error(
      "No se encontró un formulario JSF (sin input javax.faces.ViewState) en la página. " +
        "¿Cambió la estructura del sitio?"
    );
  }

  const fields: FormState = {};
  $form.find("input, select, textarea").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (!name) return;
    const type = ($el.attr("type") || "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if ($el.is(":checked")) fields[name] = $el.attr("value") ?? "on";
      return;
    }
    if (el.tagName === "select") {
      fields[name] = $el.find("option[selected]").attr("value") ?? $el.val()?.toString() ?? "";
      return;
    }
    fields[name] = $el.attr("value") ?? "";
  });

  return { formId, fields };
}

/**
 * Busca dentro del formulario un botón/link "de búsqueda" cuyo texto visible coincida con
 * palabras típicas (Buscar, Consultar, Search). Devuelve su clientId (atributo name/id),
 * usado como `javax.faces.source` del POST ajax de búsqueda.
 */
export function discoverSearchControl(
  $: cheerio.CheerioAPI,
  formId: string
): string | undefined {
  const candidates = $(`#${cssEscape(formId)} button, #${cssEscape(formId)} input[type="submit"], #${cssEscape(formId)} a`);
  let found: string | undefined;
  candidates.each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim().toLowerCase();
    const value = ($el.attr("value") || "").toLowerCase();
    if (/buscar|consultar|search/.test(text) || /buscar|consultar|search/.test(value)) {
      found = $el.attr("id") || $el.attr("name");
      return false;
    }
    return undefined;
  });
  return found;
}

/** Busca el contenedor de datatable de PrimeFaces (clase ui-datatable) dentro del form. */
export function discoverTable($: cheerio.CheerioAPI, formId: string): DiscoveredTable | undefined {
  const $table = $(`#${cssEscape(formId)} .ui-datatable`).first();
  if ($table.length === 0) return undefined;

  const dataTableId = $table.attr("id");
  if (!dataTableId) return undefined;

  const columns: string[] = [];
  $table
    .find("thead th")
    .each((_, th) => {
      const label =
        $(th).attr("aria-label")?.trim() || $(th).text().trim().replace(/\s+/g, " ");
      columns.push(label);
    });

  return { dataTableId, columns };
}

/** Extrae la info de paginación visible ("Página X de Y (Z registros)") si existe. */
export function discoverPagination(
  $: cheerio.CheerioAPI,
  rowsPerPage: number
): PaginationInfo | undefined {
  const text = $(".ui-paginator-current").first().text();
  const match = text.match(/P[aá]gina\s+(\d+)\s+de\s+(\d+)\s*\((\d+)\s*registros?\)/i);
  if (!match) return undefined;

  const currentPage = Number(match[1]);
  const totalPages = Number(match[2]);
  const totalRecords = Number(match[3]);
  return {
    currentPage,
    totalPages,
    totalRecords,
    rowsPerPage,
    hasNextPage: currentPage < totalPages,
  };
}

/**
 * Extrae las filas de datos de un datatable ya renderizado (ya sea de la carga inicial o
 * de un fragmento de partial-response). `tbodyHtml` puede ser el HTML completo de la página
 * o solo el `<tbody>`/filas actualizadas.
 */
export function extractRows(
  html: string,
  dataTableId: string,
  columns: string[],
  page: number
): DocumentRecord[] {
  // cheerio (parse5) descarta <tr>/<td> sueltos que no estén dentro de un <table>
  // (foster parenting del algoritmo de parseo HTML5). Las respuestas de paginación
  // de PrimeFaces devuelven justamente eso: <tr> sueltos sin <table> envolvente.
  // Si el fragmento ya trae su propio <table> (como en la respuesta de la búsqueda
  // inicial) lo dejamos tal cual; si no, lo envolvemos nosotros.
  const needsWrapper = !/<table[\s>]/i.test(html);
  const $ = cheerio.load(needsWrapper ? `<table><tbody>${html}</tbody></table>` : html);

  const tbodySelector = `#${cssEscape(dataTableId + "_data")}`;
  let $rows = $(tbodySelector).find("> tr");
  if ($rows.length === 0) {
    // El fragmento puede ser directamente las <tr> sin el <tbody> envolvente
    // (esto pasa en algunas respuestas parciales de paginación).
    $rows = $("tr[data-ri]");
  }

  const records: DocumentRecord[] = [];
  $rows.each((rowIndex, tr) => {
    const $tr = $(tr);
    const cells = $tr.find("> td");
    if (cells.length === 0) return;

    const fields: Record<string, string> = {};
    cells.each((i, td) => {
      const key = columns[i] ?? `col_${i}`;
      fields[key] = $(td).text().trim().replace(/\s+/g, " ");
    });

    const record: DocumentRecord = { rowIndex, page, fields };

    const extraParams = extractJsfcljsParams($tr.html() ?? "");
    if (extraParams) {
      record.pdfDownload = { extraParams };
    }

    records.push(record);
  });

  return records;
}

/**
 * Los links de descarga en portales Mojarra/PrimeFaces usan
 * `mojarra.jsfcljs(form, {'clientId':'clientId','param_uuid':'xxx'}, '')`.
 * Esta función parsea ese objeto literal para reconstruir el POST de descarga.
 */
export function extractJsfcljsParams(rowHtml: string): Record<string, string> | undefined {
  const match = rowHtml.match(/mojarra\.jsfcljs\([^,]+,\s*\{([^}]*)\}/);
  if (!match) return undefined;

  const paramsBody = match[1];
  const params: Record<string, string> = {};
  const pairRegex = /'([^']+)'\s*:\s*'([^']*)'/g;
  let pairMatch: RegExpExecArray | null;
  while ((pairMatch = pairRegex.exec(paramsBody)) !== null) {
    params[pairMatch[1]] = pairMatch[2];
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Parsea una respuesta parcial de JSF/PrimeFaces (XML con <update id="..."><![CDATA[...]]></update>). */
export function parsePartialResponse(xml: string): Map<string, string> {
  const updates = new Map<string, string>();
  const regex = /<update id="([^"]+)"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    updates.set(match[1], match[2]);
  }
  return updates;
}

function cssEscape(id: string): string {
  // Los clientId de JSF contienen ":" que debe escaparse en selectores CSS.
  return id.replace(/:/g, "\\:");
}
