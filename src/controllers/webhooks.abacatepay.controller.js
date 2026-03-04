// src/controllers/webhooks.abacatepay.controller.js
const crypto = require("crypto");
const { prisma } = require("../lib/prisma");

// ✅ Conforme docs: assinatura é HMAC-SHA256 base64 usando essa "public key"
// Você pode sobrescrever via env ABACATEPAY_PUBLIC_KEY
const DEFAULT_ABACATEPAY_PUBLIC_KEY =
  "t9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9";

const PERIOD_DAYS = 30;

function addDays(date, days) {
  const d = new Date(date);
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  return d;
}

function timingSafeEqualB64(expectedB64, receivedB64) {
  const A = Buffer.from(String(expectedB64 || ""), "utf8");
  const B = Buffer.from(String(receivedB64 || ""), "utf8");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function verifySignature(rawBody, signatureFromHeader) {
  const key = process.env.ABACATEPAY_PUBLIC_KEY || DEFAULT_ABACATEPAY_PUBLIC_KEY;

  const bodyBuffer = Buffer.from(rawBody, "utf8");
  const expectedSig = crypto.createHmac("sha256", key).update(bodyBuffer).digest("base64");

  return timingSafeEqualB64(expectedSig, signatureFromHeader);
}

function getWebhookSecretExpected() {
  // suporta os dois nomes pra você não ter dor de cabeça
  return process.env.ABACATEPAY_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "";
}

/**
 * POST /api/webhooks/abacatepay?webhookSecret=...
 * RAW BODY obrigatório (req.body é Buffer)
 */
async function abacatepayWebhook(req, res) {
  const expectedSecret = getWebhookSecretExpected();
  const receivedSecret = String(req.query?.webhookSecret || "").trim();

  if (!expectedSecret) {
    return res.status(500).json({ error: "ABACATEPAY_WEBHOOK_SECRET não configurada no servidor." });
  }

  // 1) Secret na URL
  if (receivedSecret !== expectedSecret) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  // RAW BODY
  const rawBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const rawBody = rawBuffer.toString("utf8");

  // 2) Assinatura HMAC
  const signatureHeader =
    String(req.headers["x-webhook-signature"] || req.headers["X-Webhook-Signature"] || "").trim();

  if (!signatureHeader) {
    return res.status(401).json({ error: "Missing X-Webhook-Signature" });
  }

  const signatureValid = verifySignature(rawBody, signatureHeader);
  if (!signatureValid) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Parse JSON do evento
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  const eventId = String(event?.id || "").trim();
  const eventType = String(event?.event || "").trim(); // ex: "billing.paid"
  const devMode = !!event?.devMode;

  if (!eventId || !eventType) {
    return res.status(400).json({ error: "Missing event.id or event.event" });
  }

  // Pelo payload docs: billing.paid pode vir com data.billing.id (cobrança) :contentReference[oaicite:5]{index=5}
  const providerBillingId =
    event?.data?.billing?.id ||
    event?.data?.pixQrCode?.id ||
    null;

  // --------------------------
  // Idempotência (WebhookEvent)
  // --------------------------
  let webhookRow = null;

  try {
    // tenta criar (se duplicado, vai cair no catch)
    webhookRow = await prisma.webhookEvent.create({
      data: {
        provider: "ABACATEPAY",
        eventId,
        eventType,
        devMode,
        signatureValid: true,
        providerBillingId: providerBillingId ? String(providerBillingId) : null,
        rawBody,
        headersJson: JSON.stringify(req.headers || {}),
      },
    });
  } catch (e) {
    // se já existe, busca e decide se já foi processado
    webhookRow = await prisma.webhookEvent.findFirst({
      where: { provider: "ABACATEPAY", eventId },
    });

    if (webhookRow?.processedAt) {
      // já processado → responde 200 e não faz nada
      return res.status(200).json({ received: true, duplicate: true });
    }

    // se existe mas não processou (falhou antes), segue processamento
    if (!webhookRow) {
      // erro diferente (muito raro)
      return res.status(500).json({ error: "Failed to register webhook event" });
    }
  }

  const now = new Date();

  try {
    // Processa com transação (pra não ativar plano sem marcar billing etc)
    await prisma.$transaction(async (tx) => {
      // atualiza a row com providerBillingId (caso tenha vindo depois)
      webhookRow = await tx.webhookEvent.update({
        where: { id: webhookRow.id },
        data: {
          providerBillingId: providerBillingId ? String(providerBillingId) : webhookRow.providerBillingId,
        },
      });

      // --------------------------
      // billing.paid → ativa/renova
      // --------------------------
      if (eventType === "billing.paid") {
        const billingId = providerBillingId ? String(providerBillingId) : null;
        if (!billingId) {
          throw new Error("billing.paid sem data.billing.id (providerBillingId).");
        }

        const saasBilling = await tx.saasBilling.findFirst({
          where: { provider: "ABACATEPAY", providerBillingId: billingId },
        });

        if (!saasBilling) {
          throw new Error(`SaasBilling não encontrado para providerBillingId=${billingId}`);
        }

        const payment = event?.data?.payment || {};
        const billingObj = event?.data?.billing || {};
        const providerCustomerId = billingObj?.customer?.id ? String(billingObj.customer.id) : null;

        const paidAmount =
          typeof billingObj?.paidAmount === "number"
            ? billingObj.paidAmount
            : (typeof payment?.amount === "number" ? payment.amount : null);

        const fee =
          typeof payment?.fee === "number"
            ? payment.fee
            : null;

        const method = payment?.method ? String(payment.method) : null;

        // marca billing como pago
        const updatedBilling = await tx.saasBilling.update({
          where: { id: saasBilling.id },
          data: {
            status: "PAID",
            paidAt: now,
            paidAmountCents: paidAmount ?? saasBilling.paidAmountCents,
            feeCents: fee ?? saasBilling.feeCents,
            paidMethod: method ?? saasBilling.paidMethod,
            providerCustomerId: providerCustomerId ?? saasBilling.providerCustomerId,
          },
        });

        // atualiza tenant: renova 30 dias a partir do maior entre planEndsAt e now
        const salon = await tx.salon.findUnique({
          where: { id: updatedBilling.salonId },
          select: { id: true, planEndsAt: true },
        });

        if (!salon) throw new Error("Salon não encontrado para ativação.");

        const base = salon.planEndsAt && new Date(salon.planEndsAt) > now ? new Date(salon.planEndsAt) : now;
        const newEndsAt = addDays(base, PERIOD_DAYS);

        await tx.salon.update({
          where: { id: updatedBilling.salonId },
          data: {
            plan: updatedBilling.plan,          // PRO/PREMIUM
            planStatus: "ACTIVE",
            planEndsAt: newEndsAt,
            cancelAtPeriodEnd: false,
            cancelRequestedAt: null,
          },
        });

        // vincula webhook ao billing/salon e marca processado
        await tx.webhookEvent.update({
          where: { id: webhookRow.id },
          data: {
            saasBillingId: updatedBilling.id,
            salonId: updatedBilling.salonId,
            processedAt: now,
            processingError: null,
          },
        });

        return;
      }

      // Outros eventos suportados (withdraw.done/withdraw.failed) → apenas marca processado
      await tx.webhookEvent.update({
        where: { id: webhookRow.id },
        data: { processedAt: now, processingError: null },
      });
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    const msg = err?.message || String(err);

    // registra falha mas mantém idempotência (próximo retry continua se processedAt ainda null)
    try {
      await prisma.webhookEvent.update({
        where: { id: webhookRow.id },
        data: { processingError: msg },
      });
    } catch (_) {}

    return res.status(500).json({ error: "Webhook processing failed", details: msg });
  }
}

module.exports = {
  abacatepayWebhook,
};