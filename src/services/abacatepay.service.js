// src/services/abacatepay.service.js
const https = require("https");

const BASE_URL = "https://api.abacatepay.com/v1";

function requestJson(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const payload = body ? JSON.stringify(body) : null;

    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + (u.search || ""),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };

    const req = https.request(opts, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        const status = res.statusCode || 0;

        let json;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (e) {
          return reject(
            new Error(`AbacatePay respondeu não-JSON (status ${status}): ${raw?.slice(0, 500)}`)
          );
        }

        if (status < 200 || status >= 300) {
          const msg =
            json?.error?.message ||
            json?.message ||
            `Erro AbacatePay (status ${status})`;
          return reject(new Error(msg));
        }

        return resolve(json);
      });
    });

    req.on("error", (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function getApiKey() {
  const key = process.env.ABACATEPAY_API_KEY;
  if (!key) throw new Error("ABACATEPAY_API_KEY não configurada.");
  return key;
}

/**
 * Cria uma cobrança (billing) ONE_TIME na AbacatePay.
 * Docs: POST /v1/billing/create
 */
async function createBilling(payload) {
  const key = getApiKey();

  // Authorization Bearer obrigatório
  // + campos obrigatórios: frequency, methods, products, returnUrl, completionUrl
  const res = await requestJson("POST", `${BASE_URL}/billing/create`, payload, {
    Authorization: `Bearer ${key}`,
  });

  // padrão da API: { data: {...}, error: null }
  if (res?.error) {
    const msg = res.error?.message || "Erro ao criar cobrança na AbacatePay.";
    throw new Error(msg);
  }

  if (!res?.data?.id || !res?.data?.url) {
    throw new Error("Resposta inesperada da AbacatePay ao criar cobrança.");
  }

  return res.data;
}

module.exports = {
  createBilling,
};