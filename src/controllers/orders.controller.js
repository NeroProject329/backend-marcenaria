const { prisma } = require("../lib/prisma");

// helpers
function toInt(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: `Campo inválido: ${field}` };
  }
  return { ok: true, value: n };
}

function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeStatus(v) {
  if (!v) return undefined;
  const s = String(v).trim().toUpperCase();
  const allowed = new Set([
    "ORCAMENTO",
    "PEDIDO",
    "EM_PRODUCAO",
    "PRONTO",
    "ENTREGUE",
    "CANCELADO",
  ]);
  return allowed.has(s) ? s : null;
}

// pagamentos
const VALID_PAYMENT_MODE = new Set(["AVISTA", "PARCELADO"]);
const VALID_PAYMENT_METHOD = new Set([
  "PIX",
  "CARTAO",
  "DINHEIRO",
  "BOLETO",
  "TRANSFERENCIA",
  "OUTRO",
]);

function normalizePaymentMode(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const m = String(v).trim().toUpperCase();
  return VALID_PAYMENT_MODE.has(m) ? m : null;
}

function normalizePaymentMethod(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const m = String(v).trim().toUpperCase();
  return VALID_PAYMENT_METHOD.has(m) ? m : null;
}

function toBool(v) {
  if (v === true || v === false) return v;
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

// totais
function calcTotals(items, discountCents = 0) {
  const subtotal = items.reduce((sum, it) => sum + it.totalCents, 0);
  const total = Math.max(0, subtotal - (discountCents || 0));
  return { subtotalCents: subtotal, totalCents: total };
}

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);

  // evita "pular" (ex.: 31 -> fevereiro)
  while (d.getDate() < day) d.setDate(d.getDate() - 1);
  return d;
}

// Divide total em N parcelas, garantindo soma exata (última recebe o resto)
function splitIntoInstallments(totalCents, count) {
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;

  const arr = Array.from({ length: count }, () => base);
  arr[count - 1] = base + remainder;
  return arr;
}

/**
 * ✅ CREATE ORDER + AUTO RECEIVABLES (com pagamento no Order + paidNow)
 * POST /api/orders
 *
 * body:
 *  - clientId (obrigatório)
 *  - items (obrigatório)
 *  - discountCents?
 *  - expectedDeliveryAt?
 *  - status?
 *  - notes?
 *
 *  - paymentMode?: "AVISTA" | "PARCELADO" (default AVISTA)
 *  - paymentMethod?: "PIX" | "CARTAO" | ...
 *  - installmentsCount?: number (obrigatório se PARCELADO)
 *  - firstDueDate?: ISO date (se não vier: usa expectedDeliveryAt ou hoje)
 *  - paidNow?: boolean (somente se AVISTA) -> parcela 1 já nasce PAGO
 */
async function createOrder(req, res) {
  const { salonId } = req.user;

  const {
    clientId,
    status,
    expectedDeliveryAt,
    notes,
    discountCents,
    items,

    // pagamento
    paymentMode,
    paymentMethod,
    installmentsCount,
    firstDueDate,

    // ✅ novo
    paidNow,
  } = req.body;

  if (!clientId) {
    return res.status(400).json({ message: "clientId é obrigatório." });
  }

  const client = await prisma.client.findFirst({
    where: { id: clientId, salonId },
    select: { id: true },
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado." });

  const statusNorm = status ? normalizeStatus(status) : "ORCAMENTO";
  if (status && statusNorm === null) {
    return res.status(400).json({ message: "Status inválido." });
  }

  const exp = toDateOrNull(expectedDeliveryAt);
  if (expectedDeliveryAt && !exp) {
    return res.status(400).json({ message: "expectedDeliveryAt inválido (use ISO date)." });
  }

  const disc = discountCents !== undefined
    ? toInt(discountCents, "discountCents")
    : { ok: true, value: 0 };
  if (!disc.ok) return res.status(400).json({ message: disc.message });
  if (disc.value < 0) return res.status(400).json({ message: "discountCents inválido." });

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "items deve ser um array com pelo menos 1 item." });
  }

  // normaliza itens
  const itemsNorm = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const name = String(it.name || "").trim();
    if (name.length < 2) {
      return res.status(400).json({ message: `Item ${i + 1}: nome inválido.` });
    }

    const q = toInt(it.quantity ?? 1, `items[${i}].quantity`);
    if (!q.ok) return res.status(400).json({ message: q.message });
    if (q.value <= 0) return res.status(400).json({ message: `Item ${i + 1}: quantity inválido.` });

    const up = toInt(it.unitPriceCents ?? 0, `items[${i}].unitPriceCents`);
    if (!up.ok) return res.status(400).json({ message: up.message });
    if (up.value < 0) return res.status(400).json({ message: `Item ${i + 1}: unitPriceCents inválido.` });

    const totalCents = q.value * up.value;

    itemsNorm.push({
      name,
      description: it.description ? String(it.description).trim() : null,
      quantity: q.value,
      unitPriceCents: up.value,
      totalCents,
    });
  }

  const totals = calcTotals(itemsNorm, disc.value);

  // pagamento: mode e method
  const modeNorm = normalizePaymentMode(paymentMode) || "AVISTA";
  if (paymentMode !== undefined && modeNorm === null) {
    return res.status(400).json({ message: "paymentMode inválido (AVISTA ou PARCELADO)." });
  }

  const methodNorm = normalizePaymentMethod(paymentMethod);
  if (paymentMethod !== undefined && methodNorm === null) {
    return res.status(400).json({ message: "paymentMethod inválido." });
  }

  let count = 1;
  if (modeNorm === "PARCELADO") {
    const c = toInt(installmentsCount, "installmentsCount");
    if (!c.ok) return res.status(400).json({ message: c.message });
    if (c.value < 2 || c.value > 24) {
      return res.status(400).json({ message: "installmentsCount deve ser entre 2 e 24." });
    }
    count = c.value;
  }

  // firstDueDate
  const parsedFirst = toDateOrNull(firstDueDate);
  if (firstDueDate && !parsedFirst) {
    return res.status(400).json({ message: "firstDueDate inválido (use ISO date)." });
  }

  const baseDue = parsedFirst || exp || new Date();

  // ✅ paidNow só vale para AVISTA
  const paidNowBool = modeNorm === "AVISTA" ? toBool(paidNow) : false;

  // gera parcelas automaticamente
  const amounts = splitIntoInstallments(totals.totalCents, count);

  const now = new Date();

  const installmentsData = amounts.map((amt, idx) => {
    const isFirst = idx === 0;

    // se AVISTA + paidNow -> 1ª parcela nasce PAGO
    const status = (paidNowBool && isFirst) ? "PAGO" : "PENDENTE";
    const paidAt = (paidNowBool && isFirst) ? now : null;

    return {
      number: idx + 1,
      dueDate: addMonths(baseDue, idx),
      amountCents: amt,
      status,
      paidAt,
      method: methodNorm || null,
    };
  });

  // cria Order + Receivable numa transaction
  const created = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        salonId,
        clientId,
        status: statusNorm || "ORCAMENTO",
        expectedDeliveryAt: exp,
        notes: notes ? String(notes).trim() : null,
        discountCents: disc.value,
        subtotalCents: totals.subtotalCents,
        totalCents: totals.totalCents,

        // ✅ salvar pagamento no Order (precisa estar no schema)
        paymentMode: modeNorm,
        paymentMethod: methodNorm || null,
        installmentsCount: count,
        firstDueDate: baseDue,

        items: { create: itemsNorm },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        expectedDeliveryAt: true,
        subtotalCents: true,
        discountCents: true,
        totalCents: true,

        // ✅ retornar pagamento do Order
        paymentMode: true,
        paymentMethod: true,
        installmentsCount: true,
        firstDueDate: true,

        client: { select: { id: true, name: true, phone: true, type: true } },
        items: {
          select: {
            id: true,
            name: true,
            quantity: true,
            unitPriceCents: true,
            totalCents: true,
          },
        },
      },
    });

    const receivable = await tx.receivable.create({
      data: {
        salonId,
        orderId: order.id,
        totalCents: totals.totalCents,
        method: methodNorm || null,
        installments: { create: installmentsData },
      },
      select: {
        id: true,
        totalCents: true,
        method: true,
        installments: {
          orderBy: { number: "asc" },
          select: {
            id: true,
            number: true,
            dueDate: true,
            amountCents: true,
            status: true,
            paidAt: true,
            method: true,
          },
        },
      },
    });

    return { order, receivable };
  });

  return res.status(201).json(created);
}

module.exports = {
  createOrder,
};

