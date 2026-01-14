const { prisma } = require("../lib/prisma");

const VALID_METHODS = new Set([
  "PIX",
  "CARTAO",
  "DINHEIRO",
  "BOLETO",
  "TRANSFERENCIA",
  "OUTRO",
]);

function toInt(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: `Campo inválido: ${field}` };
  }
  return { ok: true, value: n };
}

function toDate(v, field) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) {
    return { ok: false, message: `Data inválida: ${field}` };
  }
  return { ok: true, value: d };
}

function normalizeMethod(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const m = String(v).trim().toUpperCase();
  return VALID_METHODS.has(m) ? m : null;
}

function normalizeInstallmentStatus(v) {
  if (!v) return undefined;
  const s = String(v).trim().toUpperCase();
  const allowed = new Set(["PENDENTE", "PAGO", "ATRASADO", "CANCELADO"]);
  return allowed.has(s) ? s : null;
}

// GET /api/receivables?orderId=
async function listReceivables(req, res) {
  const { salonId } = req.user;
  const { orderId } = req.query;

  const where = { salonId };
  if (orderId) where.orderId = orderId;

  const receivables = await prisma.receivable.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderId: true,
      totalCents: true,
      method: true,
      createdAt: true,
      updatedAt: true,
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

  return res.json({ receivables });
}

// GET /api/receivables/:id
async function getReceivable(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const receivable = await prisma.receivable.findFirst({
    where: { id, salonId },
    select: {
      id: true,
      orderId: true,
      totalCents: true,
      method: true,
      createdAt: true,
      updatedAt: true,
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

  if (!receivable) return res.status(404).json({ message: "Recebimento não encontrado." });
  return res.json({ receivable });
}

// POST /api/receivables
// body: { orderId, method?, installments: [{ dueDate, amountCents }] }
// totalCents = soma parcelas (ou você pode mandar e validar)
async function createReceivable(req, res) {
  const { salonId } = req.user;
  const { orderId, method, installments } = req.body;

  if (!orderId) return res.status(400).json({ message: "orderId é obrigatório." });

  const order = await prisma.order.findFirst({
    where: { id: orderId, salonId },
    select: { id: true },
  });
  if (!order) return res.status(404).json({ message: "Pedido não encontrado." });

  const methodNorm = normalizeMethod(method);
  if (method !== undefined && methodNorm === null) {
    return res.status(400).json({ message: "method inválido." });
  }

  if (!Array.isArray(installments) || installments.length === 0) {
    return res.status(400).json({ message: "installments deve ser um array com pelo menos 1 parcela." });
  }

  const instNorm = [];
  let total = 0;

  for (let i = 0; i < installments.length; i++) {
    const it = installments[i] || {};

    const due = toDate(it.dueDate, `installments[${i}].dueDate`);
    if (!due.ok) return res.status(400).json({ message: due.message });

    const amt = toInt(it.amountCents, `installments[${i}].amountCents`);
    if (!amt.ok) return res.status(400).json({ message: amt.message });
    if (amt.value <= 0) return res.status(400).json({ message: `Parcela ${i + 1}: amountCents inválido.` });

    total += amt.value;

    const instMethodNorm = normalizeMethod(it.method);
    if (it.method !== undefined && instMethodNorm === null) {
      return res.status(400).json({ message: `Parcela ${i + 1}: method inválido.` });
    }

    instNorm.push({
      number: i + 1,
      dueDate: due.value,
      amountCents: amt.value,
      status: "PENDENTE",
      method: instMethodNorm || methodNorm || null,
    });
  }

  const created = await prisma.receivable.create({
    data: {
      salonId,
      orderId,
      totalCents: total,
      method: methodNorm || null,
      installments: { create: instNorm },
    },
    select: {
      id: true,
      orderId: true,
      totalCents: true,
      method: true,
      createdAt: true,
      installments: {
        orderBy: { number: "asc" },
        select: { id: true, number: true, dueDate: true, amountCents: true, status: true, paidAt: true, method: true },
      },
    },
  });

  return res.status(201).json({ receivable: created });
}

// PATCH /api/receivables/:id
// Atualiza method (geral) - não mexe em parcelas aqui
async function updateReceivable(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;
  const { method } = req.body;

  const exists = await prisma.receivable.findFirst({
    where: { id, salonId },
    select: { id: true },
  });
  if (!exists) return res.status(404).json({ message: "Recebimento não encontrado." });

  const methodNorm = normalizeMethod(method);
  if (method !== undefined && methodNorm === null) {
    return res.status(400).json({ message: "method inválido." });
  }

  const receivable = await prisma.receivable.update({
    where: { id },
    data: { method: methodNorm || null },
    select: { id: true, method: true, totalCents: true },
  });

  return res.json({ receivable });
}

// PATCH /api/receivables/installments/:installmentId
// body: { status?, paidAt?, method? }
async function updateReceivableInstallment(req, res) {
  const { salonId } = req.user;
  const { installmentId } = req.params;
  const { status, paidAt, method } = req.body;

  const inst = await prisma.receivableInstallment.findFirst({
    where: { id: installmentId, receivable: { salonId } },
    select: { id: true, status: true },
  });
  if (!inst) return res.status(404).json({ message: "Parcela não encontrada." });

  const data = {};

  if (status !== undefined) {
    const s = normalizeInstallmentStatus(status);
    if (s === null) return res.status(400).json({ message: "status inválido." });
    data.status = s;

    if (s === "PAGO") {
      data.paidAt = paidAt ? new Date(paidAt) : new Date();
      if (Number.isNaN(new Date(data.paidAt).getTime())) {
        return res.status(400).json({ message: "paidAt inválido." });
      }
    }

    if (s !== "PAGO") {
      // se voltar pra pendente/atrasado/cancelado, remove paidAt
      data.paidAt = null;
    }
  }

  if (paidAt !== undefined && status === undefined) {
    // se atualizar paidAt sem status, valida
    const d = paidAt ? new Date(paidAt) : null;
    if (paidAt && Number.isNaN(d.getTime())) return res.status(400).json({ message: "paidAt inválido." });
    data.paidAt = d;
  }

  if (method !== undefined) {
    const m = normalizeMethod(method);
    if (m === null) return res.status(400).json({ message: "method inválido." });
    data.method = m || null;
  }

  const updated = await prisma.receivableInstallment.update({
    where: { id: installmentId },
    data,
    select: { id: true, number: true, dueDate: true, amountCents: true, status: true, paidAt: true, method: true },
  });

  return res.json({ installment: updated });
}

module.exports = {
  listReceivables,
  getReceivable,
  createReceivable,
  updateReceivable,
  updateReceivableInstallment,
};
