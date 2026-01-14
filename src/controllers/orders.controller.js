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

function calcTotals(items, discountCents = 0) {
  const subtotal = items.reduce((sum, it) => sum + it.totalCents, 0);
  const total = Math.max(0, subtotal - (discountCents || 0));
  return { subtotalCents: subtotal, totalCents: total };
}

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
      client: { select: { id: true, name: true, phone: true, instagram: true, notes: true, type: true } },
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
            select: { id: true, number: true, dueDate: true, amountCents: true, status: true, paidAt: true, method: true },
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

  const disc = discountCents !== undefined ? toInt(discountCents, "discountCents") : { ok: true, value: 0 };
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

  const created = await prisma.order.create({
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

  return res.status(201).json({ order: created });
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

  const { status, expectedDeliveryAt, deliveredAt, notes, discountCents, items } = req.body;

  const data = {};

  if (status !== undefined) {
    const s = normalizeStatus(status);
    if (s === null) return res.status(400).json({ message: "Status inválido." });
    data.status = s;

    // se marcou ENTREGUE, opcionalmente carimba deliveredAt (se não mandou)
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

  let itemsNorm = null;
  let discVal = null;

  if (discountCents !== undefined) {
    const disc = toInt(discountCents, "discountCents");
    if (!disc.ok) return res.status(400).json({ message: disc.message });
    if (disc.value < 0) return res.status(400).json({ message: "discountCents inválido." });
    discVal = disc.value;
    data.discountCents = discVal;
  }

  // Se mandar items, substitui TODOS (simples e seguro pro MVP)
  if (items !== undefined) {
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "items deve ser um array com pelo menos 1 item." });
    }

    itemsNorm = [];
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
  }

  // Recalcular totais se mexeu em itens ou desconto
  if (itemsNorm || discVal !== null) {
    const current = await prisma.order.findFirst({
      where: { id, salonId },
      select: { discountCents: true, items: { select: { totalCents: true } } },
    });

    const discountFinal = discVal !== null ? discVal : (current?.discountCents || 0);
    const subtotalFinal = itemsNorm
      ? itemsNorm.reduce((s, it) => s + it.totalCents, 0)
      : (current?.items || []).reduce((s, it) => s + it.totalCents, 0);

    data.subtotalCents = subtotalFinal;
    data.totalCents = Math.max(0, subtotalFinal - discountFinal);
  }

  const updated = await prisma.$transaction(async (tx) => {
    // se vai substituir itens
    if (itemsNorm) {
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      await tx.orderItem.createMany({
        data: itemsNorm.map((it) => ({ ...it, orderId: id })),
      });
    }

    return tx.order.update({
      where: { id },
      data,
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
        client: { select: { id: true, name: true, phone: true, type: true } },
        items: { select: { id: true, name: true, quantity: true, unitPriceCents: true, totalCents: true } },
      },
    });
  });

  return res.json({ order: updated });
}

// POST /api/orders/:id/cancel  (melhor do que DELETE)
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

module.exports = {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  cancelOrder,
};
