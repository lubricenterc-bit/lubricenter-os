const NOTION_VERSION = "2025-09-03";
const PRODUCTS_DATA_SOURCE = "20674115-7d25-8074-994e-000b8fb6c09b";
const RATES_DATA_SOURCE = "20674115-7d25-8061-bd45-000b6fa979f2";
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;

type NotionProperty = {
  type?: string;
  number?: number | null;
  checkbox?: boolean;
  url?: string | null;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
};
type NotionPage = {
  id: string;
  url?: string;
  properties?: Record<string, NotionProperty>;
};
type NotionQuery = {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
};

function text(parts: Array<{ plain_text?: string }> | undefined) {
  return (parts ?? []).map((part) => part.plain_text ?? "").join("").trim();
}

async function queryNotion(token: string, dataSource: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.notion.com/v1/data_sources/${dataSource}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Notion respondió ${response.status}: ${detail}`);
  }
  return await response.json() as NotionQuery;
}

async function allAvailableProducts(token: string) {
  const pages: NotionPage[] = [];
  let cursor: string | null = null;
  do {
    const result = await queryNotion(token, PRODUCTS_DATA_SOURCE, {
      page_size: 100,
      filter: { property: "Disponible", checkbox: { equals: true } },
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...(result.results ?? []));
    cursor = result.has_more ? result.next_cursor ?? null : null;
  } while (cursor);
  return pages;
}

async function supabaseRpc(name: string, body: Record<string, unknown> = {}) {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Faltan credenciales internas de Supabase");
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message ?? `Supabase respondió ${response.status}`);
  return payload;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return Response.json({ ok: false, error: "Método no permitido" }, { status: 405 });
  const notionToken = Deno.env.get("NOTION_API_TOKEN");
  if (!notionToken) {
    return Response.json({ ok: false, error: "Falta configurar NOTION_API_TOKEN" }, { status: 503 });
  }

  try {
    const status = await supabaseRpc("get_pricing_sync_status");
    const current = Array.isArray(status) ? status[0] : status;
    const lastSync = current?.catalog_synced_at ? new Date(current.catalog_synced_at).getTime() : 0;
    if (lastSync && Date.now() - lastSync < MIN_SYNC_INTERVAL_MS) {
      return Response.json({ ok: true, skipped: true, reason: "Sincronización reciente" });
    }

    const [rateResult, productPages] = await Promise.all([
      queryNotion(notionToken, RATES_DATA_SOURCE, { page_size: 10 }),
      allAvailableProducts(notionToken),
    ]);
    const ratePages = rateResult.results ?? [];
    const namedRate = ratePages.find((page) => text(page.properties?.Nombre?.title) === "Tasa Actual");
    const ratePage = namedRate ?? (ratePages.length === 1 ? ratePages[0] : undefined);
    if (!ratePage) throw new Error("No existe una única fila de tasas identificable");

    const bcv = Number(ratePage.properties?.["Tasa Oficial BCV por USD"]?.number);
    const operative = Number(ratePage.properties?.["Tasa Bs. por USD."]?.number);
    const products = productPages.map((page) => ({
      name: text(page.properties?.Nombre?.title),
      base_usd: Number(page.properties?.Precio?.number),
      category: page.properties?.["Categoría"]?.select?.name?.trim() ?? "",
      description: text(page.properties?.["Descripción"]?.rich_text),
      image_url: page.properties?.["Foto Fija"]?.url?.trim() ?? "",
      notion_url: page.url ?? "",
    }));

    const normalized = products.map((product) => product.name.toLocaleLowerCase("es"));
    const duplicate = normalized.find((name, index) => normalized.indexOf(name) !== index);
    if (!(bcv > 0) || !(operative > 0)) throw new Error("Las tasas de Notion no son válidas");
    if (!products.length || products.length > 500) throw new Error("La cantidad de productos no es válida");
    if (products.some((product) => !product.name || !Number.isFinite(product.base_usd) || product.base_usd < 0)) {
      throw new Error("Hay productos con nombre o precio inválido");
    }
    if (duplicate) throw new Error(`Producto repetido: ${duplicate}`);

    const result = await supabaseRpc("sync_notion_pricing_service", {
      p_bcv: bcv,
      p_operative: operative,
      p_products: products,
      p_synced_at: new Date().toISOString(),
    });
    return Response.json({ ok: true, result });
  } catch (error) {
    console.error("notion-pricing-sync failed", error);
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "Error desconocido de sincronización",
    }, { status: 502 });
  }
});

