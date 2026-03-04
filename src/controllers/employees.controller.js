const { prisma } = require("../lib/prisma");

function toInt(v, field) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: `Campo inválido: ${field}` };
  }
  return { ok: true, value: n };
}

function toStr(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function monthKeyFromDate(d) {
  const dt = new Date(d);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(dt);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${year}-${month}`;
}

function moneyBRL(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function buildDateForMonthSP(monthStr, dayOfMonth) {
  const [y, m] = String(monthStr || "").split("-").map(Number);
  if (!y || !m) return new Date(`${monthStr}-01T00:00:00-03:00`);

  // último dia do mês (m é 1..12)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.max(1, Math.min(lastDay, Number(dayOfMonth) || 1));
  const dd = String(d).padStart(2, "0");

  // 00:00 no fuso SP (-03:00)
  return new Date(`${monthStr}-${dd}T00:00:00-03:00`);
}

function validatePayDay(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, message: "payDay inválido." };
  if (n < 1 || n > 31) return { ok: false, message: "payDay inválido (1..31)." };
  return { ok: true, value: n };
}

function payrollName(emp) {
  const role = emp.role ? ` (${emp.role})` : "";
  return `Funcionário: ${emp.name}${role}`;
}

function payrollDescription(emp) {
  const parts = [];
  if (emp.role) parts.push(`Função: ${emp.role}`);
  if (emp.sector) parts.push(`Setor: ${emp.sector}`);
  parts.push(`Salário: ${moneyBRL(emp.salaryCents)}`);
  parts.push(`Benefícios: ${moneyBRL(emp.benefitsCents)}`);
  parts.push(`Dia pagamento: ${emp.payDay}`);
  return parts.join(" | ");
}

async function upsertPayrollCost(tx, salonId, emp, yearMonth, isRecurring) {
  const amountCents = (emp.salaryCents || 0) + (emp.benefitsCents || 0);
  const occurredAt = buildDateForMonthSP(yearMonth, emp.payDay);

  const existing = await tx.cost.findFirst({
    where: {
      salonId,
      recurringGroupId: emp.payrollRecurringGroupId,
      yearMonth,
    },
    select: { id: true },
  });

  const data = {
    salonId,
    type: "FIXO",
    name: payrollName(emp),
    description: payrollDescription(emp),
    category: "FOLHA",
    isRecurring: !!isRecurring,
    recurringGroupId: emp.payrollRecurringGroupId,
    yearMonth,
    amountCents,
    occurredAt,
    supplierId: null,
  };

  if (existing) {
    await tx.cost.update({
      where: { id: existing.id },
      data,
      select: { id: true },
    });
    return;
  }

  await tx.cost.create({ data, select: { id: true } });
}

// GET /api/employees
async function listEmployees(req, res) {
  const { salonId } = req.user;

  const employees = await prisma.employee.findMany({
    where: { salonId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      role: true,
      sector: true,
      salaryCents: true,
      benefitsCents: true,
      payDay: true,
      isActive: true,
      payrollRecurringGroupId: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const mapped = employees.map((e) => ({
    ...e,
    totalCents: (e.salaryCents || 0) + (e.benefitsCents || 0),
  }));

  return res.json({ employees: mapped });
}

// GET /api/employees/:id
async function getEmployee(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const employee = await prisma.employee.findFirst({
    where: { id, salonId },
    select: {
      id: true,
      name: true,
      role: true,
      sector: true,
      salaryCents: true,
      benefitsCents: true,
      payDay: true,
      isActive: true,
      payrollRecurringGroupId: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!employee) return res.status(404).json({ message: "Funcionário não encontrado." });

  return res.json({
    employee: { ...employee, totalCents: (employee.salaryCents || 0) + (employee.benefitsCents || 0) },
  });
}

// POST /api/employees
async function createEmployee(req, res) {
  const { salonId } = req.user;

  const name = toStr(req.body.name);
  const role = toStr(req.body.role);
  const sector = toStr(req.body.sector);
  const notes = toStr(req.body.notes);

  if (!name || name.length < 2) {
    return res.status(400).json({ message: "name é obrigatório." });
  }

  const salary = toInt(req.body.salaryCents ?? 0, "salaryCents");
  if (!salary.ok || salary.value < 0) return res.status(400).json({ message: "salaryCents inválido." });

  const benefits = toInt(req.body.benefitsCents ?? 0, "benefitsCents");
  if (!benefits.ok || benefits.value < 0) return res.status(400).json({ message: "benefitsCents inválido." });

  const pd = validatePayDay(req.body.payDay ?? 5);
  if (!pd.ok) return res.status(400).json({ message: pd.message });

  const isActive = req.body.isActive === undefined ? true : !!req.body.isActive;

  const payrollRecurringGroupId = `emp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const yearMonth = monthKeyFromDate(new Date());

  const employee = await prisma.$transaction(async (tx) => {
    const emp = await tx.employee.create({
      data: {
        salonId,
        name,
        role,
        sector,
        salaryCents: salary.value,
        benefitsCents: benefits.value,
        payDay: pd.value,
        isActive,
        payrollRecurringGroupId,
        notes,
      },
      select: {
        id: true,
        name: true,
        role: true,
        sector: true,
        salaryCents: true,
        benefitsCents: true,
        payDay: true,
        isActive: true,
        payrollRecurringGroupId: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Integração com Custos FIXOS: cria/atualiza o custo deste mês
    await upsertPayrollCost(tx, salonId, emp, yearMonth, emp.isActive);

    return emp;
  });

  return res.status(201).json({
    employee: { ...employee, totalCents: (employee.salaryCents || 0) + (employee.benefitsCents || 0) },
  });
}

// PATCH /api/employees/:id
async function updateEmployee(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.employee.findFirst({
    where: { id, salonId },
    select: {
      id: true,
      isActive: true,
      payrollRecurringGroupId: true,
    },
  });
  if (!exists) return res.status(404).json({ message: "Funcionário não encontrado." });

  const data = {};

  if (req.body.name !== undefined) {
    const v = toStr(req.body.name);
    if (!v || v.length < 2) return res.status(400).json({ message: "name inválido." });
    data.name = v;
  }
  if (req.body.role !== undefined) data.role = toStr(req.body.role);
  if (req.body.sector !== undefined) data.sector = toStr(req.body.sector);
  if (req.body.notes !== undefined) data.notes = toStr(req.body.notes);

  if (req.body.salaryCents !== undefined) {
    const salary = toInt(req.body.salaryCents, "salaryCents");
    if (!salary.ok || salary.value < 0) return res.status(400).json({ message: "salaryCents inválido." });
    data.salaryCents = salary.value;
  }

  if (req.body.benefitsCents !== undefined) {
    const benefits = toInt(req.body.benefitsCents, "benefitsCents");
    if (!benefits.ok || benefits.value < 0) return res.status(400).json({ message: "benefitsCents inválido." });
    data.benefitsCents = benefits.value;
  }

  if (req.body.payDay !== undefined) {
    const pd = validatePayDay(req.body.payDay);
    if (!pd.ok) return res.status(400).json({ message: pd.message });
    data.payDay = pd.value;
  }

  if (req.body.isActive !== undefined) {
    data.isActive = !!req.body.isActive;
  }

  const yearMonth = monthKeyFromDate(new Date());

  const employee = await prisma.$transaction(async (tx) => {
    const emp = await tx.employee.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        role: true,
        sector: true,
        salaryCents: true,
        benefitsCents: true,
        payDay: true,
        isActive: true,
        payrollRecurringGroupId: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // - Se desativou: marca o ÚLTIMO custo do grupo como isRecurring=false (para parar a geração)
    // - Se ativou/alterou valores: cria/atualiza o custo do mês atual com isRecurring=true
    if (!emp.isActive) {
      const lastCost = await tx.cost.findFirst({
        where: {
          salonId,
          recurringGroupId: emp.payrollRecurringGroupId,
        },
        orderBy: [{ yearMonth: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });

      if (lastCost) {
        await tx.cost.update({
          where: { id: lastCost.id },
          data: { isRecurring: false },
          select: { id: true },
        });
      }
    } else {
      await upsertPayrollCost(tx, salonId, emp, yearMonth, true);
    }

    return emp;
  });

  return res.json({
    employee: { ...employee, totalCents: (employee.salaryCents || 0) + (employee.benefitsCents || 0) },
  });
}

// DELETE /api/employees/:id  (soft: desativa)
async function deleteEmployee(req, res) {
  const { salonId } = req.user;
  const { id } = req.params;

  const exists = await prisma.employee.findFirst({
    where: { id, salonId },
    select: { id: true, payrollRecurringGroupId: true },
  });
  if (!exists) return res.status(404).json({ message: "Funcionário não encontrado." });

  await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id },
      data: { isActive: false },
      select: { id: true },
    });

    const lastCost = await tx.cost.findFirst({
      where: { salonId, recurringGroupId: exists.payrollRecurringGroupId },
      orderBy: [{ yearMonth: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });

    if (lastCost) {
      await tx.cost.update({
        where: { id: lastCost.id },
        data: { isRecurring: false },
        select: { id: true },
      });
    }
  });

  return res.json({ ok: true });
}

module.exports = {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
};