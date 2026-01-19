const { prisma } = require("../lib/prisma");

// ===== Helpers =====
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

function toBool(v) {
  if (v === true || v === false) return v;
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
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
  while (d.getDate() < day) d.setDate(d.getDate() - 1);
  return d;
}

function splitIntoInstallments(totalCents, count) {
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  const arr = Array.from({ length: count }, () => base);
  arr[count - 1] = base + remainder;
  return arr;
}

// ===== Controllers =====

// GET /api/orders
async function listOrders(req, res) {
  const { salonId } = req.user;
  const q = (req.query.q || "").trim();

  const status = normalizeStatus(req.query.status);
  if (req.query.status && status === null) {
    return res.status(400).json({ message: "Status inválido." });
  }

  const where = { salonId };
  if (status) where.status = status;

  if (q) {
    where.OR = [
      { client: { name: { contains: q, mode: "insensitive" } } },
      { client: { phone: { contains: q.replace(/\D/g, "") } } },
      { notes: { contains: q, mode: "insensitive" } },
    ];
  }

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      subtotalCents: true,
      discountCents: true,
      totalCents: true,
      notes: true,

      // pagamento no Order
      paymentMode: true,
      paymentMethod: true,
      installmentsCount: true,
      firstDueDate: true,

      client: { select: { id: true, name: true, phone: true, type: true } },
      items: {
        select: {
          id: true,
          name: true,
          description: true,
          quantity: true,
          unitPriceCents: true,
          totalCents: true,
        },
      },
    },
  });

  return res.json({ orders });
}

// GET /api/orders/:id
async function getOrder(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const order = await prisma.order.findFirst({
    where: { id, salonId },
    select: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      subtotalCents: true,
      discountCents: true,
      totalCents: true,
      notes: true,

      // pagamento no Order
      paymentMode: true,
      paymentMethod: true,
      installmentsCount: true,
      firstDueDate: true,

      client: {
        select: { id: true, name: true, phone: true, instagram: true, notes: true, type: true },
      },
      items: {
        select: {
          id: true,
          name: true,
          description: true,
          quantity: true,
          unitPriceCents: true,
          totalCents: true,
        },
      },
      deliveries: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          expectedAt: true,
          deliveredAt: true,
          address: true,
          notes: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      receivables: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          totalCents: true,
          method: true,
          createdAt: true,
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
      },
    },
  });

  if (!order) return res.status(404).json({ message: "Pedido não encontrado." });
  return res.json({ order });
}

// POST /api/orders
async function createOrder(req, res) {
  const { salonId } = req.user;

  const {
    clientId,
    status,
    expectedDeliveryAt,
    notes,
    discountCents,
    items,

    paymentMode,
    paymentMethod,
    installmentsCount,
    firstDueDate,
    paidNow,
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

  // itens
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

    itemsNorm.push({
      name,
      description: it.description ? String(it.description).trim() : null,
      quantity: q.value,
      unitPriceCents: up.value,
      totalCents: q.value * up.value,
    });
  }

  const totals = calcTotals(itemsNorm, disc.value);

  // pagamento
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

  const parsedFirst = toDateOrNull(firstDueDate);
  if (firstDueDate && !parsedFirst) {
    return res.status(400).json({ message: "firstDueDate inválido (use ISO date)." });
  }
  const baseDue = parsedFirst || exp || new Date();

  const paidNowBool = modeNorm === "AVISTA" ? toBool(paidNow) : false;
  const now = new Date();

  const amounts = splitIntoInstallments(totals.totalCents, count);
  const installmentsData = amounts.map((amt, idx) => {
    const isFirst = idx === 0;
    const isPaid = paidNowBool && isFirst;
    return {
      number: idx + 1,
      dueDate: addMonths(baseDue, idx),
      amountCents: amt,
      status: isPaid ? "PAGO" : "PENDENTE",
      paidAt: isPaid ? now : null,
      method: methodNorm || null,
    };
  });

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

        // ✅ esses campos precisam existir no schema
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
        notes: true,

        paymentMode: true,
        paymentMethod: true,
        installmentsCount: true,
        firstDueDate: true,

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

// PATCH /api/orders/:id
async function updateOrder(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.order.findFirst({
    where: { id, salonId },
    select: { id: true },
  });
  if (!exists) return res.status(404).json({ message: "Pedido não encontrado." });

  const { status, expectedDeliveryAt, deliveredAt, notes } = req.body;
  const data = {};

  if (status !== undefined) {
    const s = normalizeStatus(status);
    if (s === null) return res.status(400).json({ message: "Status inválido." });
    data.status = s;
    if (s === "ENTREGUE" && deliveredAt === undefined) data.deliveredAt = new Date();
  }

  if (expectedDeliveryAt !== undefined) {
    const d = toDateOrNull(expectedDeliveryAt);
    if (expectedDeliveryAt && !d) return res.status(400).json({ message: "expectedDeliveryAt inválido." });
    data.expectedDeliveryAt = d;
  }

  if (deliveredAt !== undefined) {
    const d = toDateOrNull(deliveredAt);
    if (deliveredAt && !d) return res.status(400).json({ message: "deliveredAt inválido." });
    data.deliveredAt = d;
  }

  if (notes !== undefined) data.notes = notes ? String(notes).trim() : null;

  const updated = await prisma.order.update({
    where: { id },
    data,
    select: {
      id: true,
      status: true,
      updatedAt: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      notes: true,
    },
  });

  return res.json({ order: updated });
}

// POST /api/orders/:id/cancel
async function cancelOrder(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.order.findFirst({
    where: { id, salonId },
    select: { id: true },
  });
  if (!exists) return res.status(404).json({ message: "Pedido não encontrado." });

  const order = await prisma.order.update({
    where: { id },
    data: { status: "CANCELADO" },
    select: { id: true, status: true },
  });

  return res.json({ order });
}

// DELETE /api/orders/:id
async function deleteOrder(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const order = await prisma.order.findFirst({
    where: { id, salonId },
    select: { id: true },
  });

  if (!order) {
    return res.status(404).json({ message: "Pedido não encontrado." });
  }

  await prisma.$transaction(async (tx) => {
    // remove parcelas / recebíveis
    await tx.installment.deleteMany({
      where: { receivable: { orderId: id } },
    });

    await tx.receivable.deleteMany({
      where: { orderId: id },
    });

    // remove itens
    await tx.orderItem.deleteMany({
      where: { orderId: id },
    });

    // remove pedido
    await tx.order.delete({
      where: { id },
    });
  });

  return res.json({ ok: true });
}


module.exports = {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  cancelOrder,
   deleteOrder,
};
