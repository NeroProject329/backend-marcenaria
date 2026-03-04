// src/controllers/billing.controller.js
const crypto = require("crypto");
const { prisma } = require("../lib/prisma");
const { createBilling } = require("../services/abacatepay.service");

const PERIOD_DAYS = 30;
const VALID_PLANS = ["PRO", "PREMIUM"];
const VALID_METHODS = ["PIX", "CARD"];

function toUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function getPriceCents(plan) {
  if (plan === "PRO") {
    const v = Number(process.env.SAAS_PRICE_PRO_CENTS);
    if (!Number.isFinite(v) || v <= 0) throw new Error("SAAS_PRICE_PRO_CENTS inválido.");
    return Math.round(v);
  }
  if (plan === "PREMIUM") {
    const v = Number(process.env.SAAS_PRICE_PREMIUM_CENTS);
    if (!Number.isFinite(v) || v <= 0) throw new Error("SAAS_PRICE_PREMIUM_CENTS inválido.");
    return Math.round(v);
  }
  throw new Error("Plano inválido.");
}

function normalizeMethods(methodsRaw) {
  if (!methodsRaw) return ["PIX"];

  const arr = Array.isArray(methodsRaw) ? methodsRaw : [methodsRaw];
  const normalized = arr.map((m) => toUpper(m)).filter(Boolean);

  const unique = Array.from(new Set(normalized));
  if (unique.length < 1 || unique.length > 2) return null;
  if (!unique.every((m) => VALID_METHODS.includes(m))) return null;

  return unique;
}

function generateExternalId(prefix = "saas") {
  const rand = crypto.randomBytes(10).toString("hex");
  return `${prefix}_${Date.now()}_${rand}`;
}

// POST /api/billing/checkout
async function checkout(req, res) {
  const salonId = req.user?.salonId;
  const userId = req.user?.userId;

  if (!salonId || !userId) {
    return res.status(401).json({ message: "Sem contexto do usuário (salonId/userId)." });
  }

  const plan = toUpper(req.body?.plan);
  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({ message: "Plan inválido (PRO/PREMIUM)." });
  }

  const methods = normalizeMethods(req.body?.methods);
  if (!methods) {
    return res.status(400).json({ message: "methods inválido. Use PIX e/ou CARD." });
  }

  const returnUrl = String(req.body?.returnUrl || process.env.SAAS_BILLING_RETURN_URL || "").trim();
  const completionUrl = String(
    req.body?.completionUrl ||
      req.body?.successUrl ||
      process.env.SAAS_BILLING_COMPLETION_URL ||
      ""
  ).trim();

  if (!returnUrl || !completionUrl) {
    return res.status(400).json({
      message:
        "returnUrl e completionUrl são obrigatórios (ou configure SAAS_BILLING_RETURN_URL e SAAS_BILLING_COMPLETION_URL).",
    });
  }

  // Carrega salão + owner para preencher customer (se não vier no body)
  const salon = await prisma.salon.findUnique({
    where: { id: salonId },
    select: {
      id: true,
      name: true,
      phone: true,
      owner: { select: { name: true, email: true, phone: true } },
    },
  });

  if (!salon) return res.status(404).json({ message: "Salão não encontrado." });

  // ✅ AbacatePay exige: name, cellphone, email, taxId (CPF/CNPJ)
  const bodyCustomer = req.body?.customer || {};

  const customer = {
    name: String(bodyCustomer.name || salon.owner?.name || salon.name || "").trim(),
    email: String(bodyCustomer.email || salon.owner?.email || "").trim(),
    cellphone: String(bodyCustomer.cellphone || salon.owner?.phone || salon.phone || "").trim(),
    taxId: String(bodyCustomer.taxId || req.body?.taxId || "").trim(),
  };

  const missing = [];
  if (!customer.name) missing.push("customer.name");
  if (!customer.email) missing.push("customer.email");
  if (!customer.cellphone) missing.push("customer.cellphone");
  if (!customer.taxId) missing.push("customer.taxId");

  if (missing.length) {
    return res.status(400).json({
      message:
        "Dados do pagador incompletos. AbacatePay exige name, email, cellphone e taxId (CPF/CNPJ).",
      missing,
    });
  }

  let amountCents;
  try {
    amountCents = getPriceCents(plan);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Config de preço inválida." });
  }

  // Cria registro interno primeiro (histórico)
  const externalId = generateExternalId("sb");
  const metadata = {
    salonId,
    plan,
    periodDays: PERIOD_DAYS,
    saasBillingExternalId: externalId,
  };

  const product = {
    externalId: `saas_${plan.toLowerCase()}_30d`,
    name: `Marcenaria SaaS — Plano ${plan} (30 dias)`,
    description: `Acesso ao plano ${plan} por ${PERIOD_DAYS} dias.`,
    quantity: 1,
    price: amountCents,
  };

  let billingRow = null;

  try {
    billingRow = await prisma.saasBilling.create({
      data: {
        salonId,
        provider: "ABACATEPAY",
        status: "PENDING",
        plan,
        periodDays: PERIOD_DAYS,
        amountCents,
        currency: "BRL",
        externalId,
        metadataJson: JSON.stringify(metadata),
      },
      select: {
        id: true,
        provider: true,
        status: true,
        plan: true,
        periodDays: true,
        amountCents: true,
        providerBillingId: true,
        providerCheckoutUrl: true,
      },
    });

    // Cria cobrança na AbacatePay
    const abacate = await createBilling({
      frequency: "ONE_TIME",
      methods,
      products: [product],
      returnUrl,
      completionUrl,
      customer,
      allowCoupons: false,
      coupons: [],
      externalId, // opcional, mas ajuda a rastrear
      metadata,   // opcional, mas ajuda webhook/map
    });

    // Atualiza registro com ids/urls do provedor
    const updated = await prisma.saasBilling.update({
      where: { id: billingRow.id },
      data: {
        providerBillingId: abacate.id,
        providerCheckoutUrl: abacate.url,
        providerDevMode: !!abacate.devMode,
      },
      select: {
        id: true,
        provider: true,
        status: true,
        plan: true,
        periodDays: true,
        amountCents: true,
        providerBillingId: true,
        providerCheckoutUrl: true,
      },
    });

    return res.json({
      checkoutUrl: updated.providerCheckoutUrl,
      billing: updated,
    });
  } catch (e) {
    // se falhou depois de criar a linha interna, limpamos para não poluir histórico
    if (billingRow?.id) {
      try {
        await prisma.saasBilling.delete({ where: { id: billingRow.id } });
      } catch (_) {}
    }

    return res.status(400).json({
      message: "Falha ao criar checkout.",
      error: e?.message || String(e),
    });
  }
}

module.exports = {
  checkout,
};