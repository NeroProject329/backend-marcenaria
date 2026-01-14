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

function calcTotals(items, discountCents = 0) {
  const subtotal = items.reduce((sum, it) => sum + it.totalCents, 0);
  const total = Math.max(0, subtotal - (discountCents || 0));
  return { subtotalCents: subtotal, totalCents: total };
}

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);

  // Ajuste simples pra evitar "pular" quando o mês não tem o mesmo dia
  // Ex: 31 -> fevereiro
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
 * ✅ CREATE ORDER + AUTO RECEIVABLES
 * POST /api/orders
 * body:
 *  - clientId (obrigatório)
 *  - items (obrigatório)
 *  - discountCents?
 *  - expectedDeliveryAt?
 *  - status?
 *  - notes?
 *  - paymentMode?: "AVISTA" | "PARCELADO"
 *  - paymentMethod?: "PIX" | ...
 *  - installmentsCount?: number (se PARCELADO)
 *  - firstDueDate?: ISO date (se não vier: usa expectedDeliveryAt ou hoje)
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

    // 🔥 novos campos
    paymentMode,
    paymentMethod,
    installmentsCount,
    firstDueDate,
  } = req.body;

  if (!clientId) return res.status(400).json({ message: "clientId é obrigatório." });

  const client = await prisma.client.findFirst({
    where: { id: clientId, salonId },
    select: { id: true },
  });
  if (!client) return res.status(404).json({ message: "Cliente não encontrado." });

  const statusNorm = status ? normalizeStatus(status) : "ORCAMENTO";
  if (status && statusNorm === null) return res.status(400).json({ message: "Status inválido." });

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

  // normaliza itens e calcula totais
  const itemsNorm = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const name = String(it.name || "").trim();
    if (name.length < 2) return res.status(400).json({ message: `Item ${i + 1}: nome inválido.` });

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

  // ✅ novos campos: validação de pagamento
  const modeNorm = normalizePaymentMode(paymentMode) || "AVISTA";
  if (paymentMode !== undefined && modeNorm === null) {
    return res.status(400).json({ message: 'paymentMode inválido (AVISTA ou PARCELADO).' });
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

  // base da 1ª parcela:
  // prioridade: firstDueDate -> expectedDeliveryAt -> hoje
  const baseDue =
    toDateOrNull(firstDueDate) ||
    exp ||
    new Date();

  if (firstDueDate && !toDateOrNull(firstDueDate)) {
    return res.status(400).json({ message: "firstDueDate inválido (use ISO date)." });
  }

  // gera parcelas automaticamente
  const amounts = splitIntoInstallments(totals.totalCents, count);
  const installmentsData = amounts.map((amt, idx) => ({
    number: idx + 1,
    dueDate: addMonths(baseDue, idx),
    amountCents: amt,
    status: "PENDENTE",             // ✅ padrão (mais seguro)
    method: methodNorm || null,
  }));

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
        client: { select: { id: true, name: true, phone: true, type: true } },
        items: { select: { id: true, name: true, quantity: true, unitPriceCents: true, totalCents: true } },
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
          select: { id: true, number: true, dueDate: true, amountCents: true, status: true, paidAt: true, method: true },
        },
      },
    });

    return { order, receivable };
  });

  return res.status(201).json(created);
}

module.exports = {
  // ... mantenha os outros exports que já existem no seu controller:
  // listOrders, getOrder, updateOrder, cancelOrder,
  createOrder,
};
