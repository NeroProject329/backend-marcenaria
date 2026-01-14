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

// GET /api/payables?supplierId=
async function listPayables(req, res) {
  const { salonId } = req.user;
  const { supplierId } = req.query;

  const where = { salonId };
  if (supplierId) where.supplierId = supplierId;

  const payables = await prisma.payable.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      description: true,
      totalCents: true,
      createdAt: true,
      updatedAt: true,
      supplier: { select: { id: true, name: true, phone: true, type: true } },
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

  return res.json({ payables });
}

// GET /api/payables/:id
async function getPayable(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const payable = await prisma.payable.findFirst({
    where: { id, salonId },
    select: {
      id: true,
      description: true,
      totalCents: true,
      createdAt: true,
      updatedAt: true,
      supplier: { select: { id: true, name: true, phone: true, instagram: true, notes: true, type: true } },
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

  if (!payable) return res.status(404).json({ message: "Pagamento/conta não encontrado." });
  return res.json({ payable });
}

// POST /api/payables
// body: { description, supplierId?, installments: [{ dueDate, amountCents, method? }] }
async function createPayable(req, res) {
  const { salonId } = req.user;
  const { description, supplierId, installments } = req.body;

  if (!description || String(description).trim().length < 2) {
    return res.status(400).json({ message: "description é obrigatório." });
  }

  // supplier é opcional, mas se vier, valida se é do salão
  if (supplierId) {
    const supplier = await prisma.client.findFirst({
      where: { id: supplierId, salonId },
      select: { id: true, type: true },
    });
    if (!supplier) return res.status(404).json({ message: "Fornecedor não encontrado." });

    // regra do MVP: permitir apenas FORNECEDOR ou BOTH (não bloqueia o sistema, mas garante coerência)
    if (supplier.type !== "FORNECEDOR" && supplier.type !== "BOTH") {
      return res.status(400).json({ message: "supplierId precisa ser um Client do tipo FORNECEDOR ou BOTH." });
    }
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

    const m = normalizeMethod(it.method);
    if (it.method !== undefined && m === null) {
      return res.status(400).json({ message: `Parcela ${i + 1}: method inválido.` });
    }

    instNorm.push({
      number: i + 1,
      dueDate: due.value,
      amountCents: amt.value,
      status: "PENDENTE",
      method: m || null,
    });
  }

  const created = await prisma.payable.create({
    data: {
      salonId,
      supplierId: supplierId || null,
      description: String(description).trim(),
      totalCents: total,
      installments: { create: instNorm },
    },
    select: {
      id: true,
      description: true,
      totalCents: true,
      createdAt: true,
      supplier: { select: { id: true, name: true, phone: true, type: true } },
      installments: {
        orderBy: { number: "asc" },
        select: { id: true, number: true, dueDate: true, amountCents: true, status: true, paidAt: true, method: true },
      },
    },
  });

  return res.status(201).json({ payable: created });
}

// PATCH /api/payables/:id
// Atualiza description e supplierId (não mexe em parcelas aqui)
async function updatePayable(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;
  const { description, supplierId } = req.body;

  const exists = await prisma.payable.findFirst({
    where: { id, salonId },
    select: { id: true },
  });
  if (!exists) return res.status(404).json({ message: "Pagamento/conta não encontrado." });

  const data = {};

  if (description !== undefined) {
    if (!description || String(description).trim().length < 2) {
      return res.status(400).json({ message: "description inválido." });
    }
    data.description = String(description).trim();
  }

  if (supplierId !== undefined) {
    if (!supplierId) {
      data.supplierId = null;
    } else {
      const supplier = await prisma.client.findFirst({
        where: { id: supplierId, salonId },
        select: { id: true, type: true },
      });
      if (!supplier) return res.status(404).json({ message: "Fornecedor não encontrado." });
      if (supplier.type !== "FORNECEDOR" && supplier.type !== "BOTH") {
        return res.status(400).json({ message: "supplierId precisa ser um Client do tipo FORNECEDOR ou BOTH." });
      }
      data.supplierId = supplierId;
    }
  }

  const payable = await prisma.payable.update({
    where: { id },
    data,
    select: {
      id: true,
      description: true,
      totalCents: true,
      supplier: { select: { id: true, name: true, type: true } },
    },
  });

  return res.json({ payable });
}

// PATCH /api/payables/installments/:installmentId
// body: { status?, paidAt?, method? }
async function updatePayableInstallment(req, res) {
  const { salonId } = req.user;
  const { installmentId } = req.params;
  const { status, paidAt, method } = req.body;

  const inst = await prisma.payableInstallment.findFirst({
    where: { id: installmentId, payable: { salonId } },
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

    if (s !== "PAGO") data.paidAt = null;
  }

  if (paidAt !== undefined && status === undefined) {
    const d = paidAt ? new Date(paidAt) : null;
    if (paidAt && Number.isNaN(d.getTime())) return res.status(400).json({ message: "paidAt inválido." });
    data.paidAt = d;
  }

  if (method !== undefined) {
    const m = normalizeMethod(method);
    if (m === null) return res.status(400).json({ message: "method inválido." });
    data.method = m || null;
  }

  const updated = await prisma.payableInstallment.update({
    where: { id: installmentId },
    data,
    select: { id: true, number: true, dueDate: true, amountCents: true, status: true, paidAt: true, method: true },
  });

  // recalcula totalCents do Payable (boa prática)
  const parent = await prisma.payableInstallment.findFirst({
    where: { id: installmentId },
    select: { payableId: true },
  });

  if (parent?.payableId) {
    const sum = await prisma.payableInstallment.aggregate({
      where: { payableId: parent.payableId },
      _sum: { amountCents: true },
    });

    await prisma.payable.update({
      where: { id: parent.payableId },
      data: { totalCents: sum._sum.amountCents || 0 },
    });
  }

  return res.json({ installment: updated });
}

module.exports = {
  listPayables,
  getPayable,
  createPayable,
  updatePayable,
  updatePayableInstallment,
};
