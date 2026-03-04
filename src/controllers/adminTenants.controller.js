// src/controllers/adminTenants.controller.js
const { prisma } = require("../lib/prisma");

function toUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function addDays(date, days) {
  const d = new Date(date);
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  return d;
}

function daysLeft(endsAt) {
  if (!endsAt) return null;
  const now = new Date();
  const end = new Date(endsAt);
  const diff = end.getTime() - now.getTime();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || null;
}

async function logAdminAction(req, action, targetSalonId, details) {
  try {
    await prisma.adminActionLog.create({
      data: {
        adminUserId: req.admin.id,
        action,
        targetSalonId: targetSalonId || null,
        detailsJson: details ? JSON.stringify(details) : null,
        ip: clientIp(req),
        userAgent: String(req.headers["user-agent"] || ""),
      },
    });
  } catch (_) {
    // nunca quebra por audit
  }
}

function computeTenantStatus(salon) {
  const now = new Date();

  const basePlan = toUpper(salon.plan || "FREE");
  const planStatus = toUpper(salon.planStatus || "ACTIVE");
  const planEndsAt = salon.planEndsAt ? new Date(salon.planEndsAt) : null;

  const overrideEnabled = !!salon.planOverrideEnabled;
  const overridePlan = toUpper(salon.planOverridePlan || basePlan);
  const overrideEndsAt = salon.planOverrideEndsAt ? new Date(salon.planOverrideEndsAt) : null;
  const overrideActive = overrideEnabled && (!overrideEndsAt || overrideEndsAt >= now);

  const effectivePlan = overrideActive ? overridePlan : basePlan;
  const effectiveEndsAt = overrideActive ? (overrideEndsAt || planEndsAt) : planEndsAt;

  // Status do tenant pra filtros do Admin
  // ACTIVE / EXPIRING / CANCEL_SCHEDULED / INACTIVE
  if (overrideActive) {
    return {
      effectivePlan,
      effectiveEndsAt,
      status: "ACTIVE",
      source: "OVERRIDE",
      cancelAtPeriodEnd: false,
      daysLeft: daysLeft(effectiveEndsAt),
    };
  }

  if (planStatus !== "ACTIVE") {
    return {
      effectivePlan,
      effectiveEndsAt,
      status: "INACTIVE",
      source: "SUBSCRIPTION",
      cancelAtPeriodEnd: !!salon.cancelAtPeriodEnd,
      daysLeft: 0,
    };
  }

  if (effectiveEndsAt && effectiveEndsAt < now) {
    return {
      effectivePlan,
      effectiveEndsAt,
      status: "INACTIVE",
      source: "SUBSCRIPTION",
      cancelAtPeriodEnd: !!salon.cancelAtPeriodEnd,
      daysLeft: 0,
    };
  }

  if (salon.cancelAtPeriodEnd) {
    return {
      effectivePlan,
      effectiveEndsAt,
      status: "CANCEL_SCHEDULED",
      source: "SUBSCRIPTION",
      cancelAtPeriodEnd: true,
      daysLeft: daysLeft(effectiveEndsAt),
    };
  }

  const dLeft = daysLeft(effectiveEndsAt);
  if (typeof dLeft === "number" && dLeft <= 7) {
    return {
      effectivePlan,
      effectiveEndsAt,
      status: "EXPIRING",
      source: "SUBSCRIPTION",
      cancelAtPeriodEnd: false,
      daysLeft: dLeft,
    };
  }

  return {
    effectivePlan,
    effectiveEndsAt,
    status: "ACTIVE",
    source: "SUBSCRIPTION",
    cancelAtPeriodEnd: false,
    daysLeft: dLeft,
  };
}

function buildSearchWhere(searchRaw) {
  const search = String(searchRaw || "").trim();
  if (!search) return {};

  return {
    OR: [
      { name: { contains: search, mode: "insensitive" } },
      { owner: { is: { email: { contains: search, mode: "insensitive" } } } },
      { owner: { is: { name: { contains: search, mode: "insensitive" } } } },
    ],
  };
}

function buildStatusWhere(statusRaw) {
  const status = toUpper(statusRaw);
  if (!status) return {};

  const now = new Date();
  const in7 = addDays(now, 7);

  const overrideActiveWhere = {
    planOverrideEnabled: true,
    OR: [{ planOverrideEndsAt: null }, { planOverrideEndsAt: { gte: now } }],
  };

  if (status === "ACTIVE") {
    // Ativo = override ativo OU assinatura ativa e não expirando (<=7d) e não cancel agendado
    return {
      OR: [
        overrideActiveWhere,
        {
          AND: [
            { planStatus: "ACTIVE" },
            { cancelAtPeriodEnd: false },
            { OR: [{ planEndsAt: null }, { planEndsAt: { gte: now } }] },
            { OR: [{ planEndsAt: null }, { planEndsAt: { gt: in7 } }] },
            { NOT: overrideActiveWhere },
          ],
        },
      ],
    };
  }

  if (status === "EXPIRING") {
    return {
      AND: [
        { planStatus: "ACTIVE" },
        { cancelAtPeriodEnd: false },
        { planEndsAt: { gte: now, lte: in7 } },
        { NOT: overrideActiveWhere },
      ],
    };
  }

  if (status === "CANCEL_SCHEDULED") {
    return {
      AND: [
        { planStatus: "ACTIVE" },
        { cancelAtPeriodEnd: true },
        { OR: [{ planEndsAt: null }, { planEndsAt: { gte: now } }] },
        { NOT: overrideActiveWhere },
      ],
    };
  }

  if (status === "INACTIVE") {
    return {
      AND: [
        {
          OR: [{ planStatus: { not: "ACTIVE" } }, { planEndsAt: { lt: now } }],
        },
        { NOT: overrideActiveWhere },
      ],
    };
  }

  return {};
}

// GET /api/admin/tenants?status=ACTIVE|EXPIRING|CANCEL_SCHEDULED|INACTIVE&search=&page=&limit=
async function listTenants(req, res) {
  const status = toUpper(req.query?.status || "");
  const searchWhere = buildSearchWhere(req.query?.search);
  const statusWhere = buildStatusWhere(status);

  const page = clampInt(req.query?.page, 1, 100000, 1);
  const limit = clampInt(req.query?.limit, 1, 100, 20);
  const skip = (page - 1) * limit;

  const where = {
    AND: [searchWhere, statusWhere],
  };

  const [total, salons] = await Promise.all([
    prisma.salon.count({ where }),
    prisma.salon.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        name: true,
        createdAt: true,
        owner: { select: { id: true, name: true, email: true } },

        plan: true,
        planStatus: true,
        planEndsAt: true,

        cancelAtPeriodEnd: true,
        cancelRequestedAt: true,

        planOverrideEnabled: true,
        planOverridePlan: true,
        planOverrideEndsAt: true,
        planOverrideReason: true,
      },
    }),
  ]);

  const items = salons.map((s) => {
    const calc = computeTenantStatus(s);
    return {
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      ownerEmail: s.owner?.email || null,
      ownerName: s.owner?.name || null,

      plan: toUpper(s.plan),
      planStatus: toUpper(s.planStatus),
      planEndsAt: s.planEndsAt,

      cancelAtPeriodEnd: !!s.cancelAtPeriodEnd,
      cancelRequestedAt: s.cancelRequestedAt,

      planOverrideEnabled: !!s.planOverrideEnabled,
      planOverridePlan: s.planOverridePlan,
      planOverrideEndsAt: s.planOverrideEndsAt,
      planOverrideReason: s.planOverrideReason,

      effectivePlan: calc.effectivePlan,
      effectiveStatus: calc.status,
      effectiveEndsAt: calc.effectiveEndsAt,
      daysLeft: calc.daysLeft,
      source: calc.source,
    };
  });

  return res.json({ items, page, limit, total });
}

// GET /api/admin/tenants/:id
async function getTenant(req, res) {
  const id = String(req.params?.id || "").trim();
  if (!id) return res.status(400).json({ message: "Informe o id do tenant." });

  const salon = await prisma.salon.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      address: true,
      phone: true,
      logoUrl: true,

      owner: { select: { id: true, name: true, email: true, phone: true } },

      plan: true,
      planStatus: true,
      planEndsAt: true,
      trialEndsAt: true,

      cancelAtPeriodEnd: true,
      cancelRequestedAt: true,

      planOverrideEnabled: true,
      planOverridePlan: true,
      planOverrideEndsAt: true,
      planOverrideReason: true,

      _count: {
        select: {
          clients: true,
          orders: true,
          budgets: true,
          services: true,
        },
      },
    },
  });

  if (!salon) return res.status(404).json({ message: "Tenant não encontrado." });

  const calc = computeTenantStatus(salon);

  return res.json({
    tenant: {
      ...salon,
      effectivePlan: calc.effectivePlan,
      effectiveStatus: calc.status,
      effectiveEndsAt: calc.effectiveEndsAt,
      daysLeft: calc.daysLeft,
      source: calc.source,
    },
  });
}

// GET /api/admin/tenants/:id/billings
async function listTenantBillings(req, res) {
  const id = String(req.params?.id || "").trim();
  if (!id) return res.status(400).json({ message: "Informe o id do tenant." });

  const exists = await prisma.salon.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return res.status(404).json({ message: "Tenant não encontrado." });

  const items = await prisma.saasBilling.findMany({
    where: { salonId: id },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      provider: true,
      status: true,
      plan: true,
      periodDays: true,
      amountCents: true,
      currency: true,

      providerBillingId: true,
      providerCheckoutUrl: true,
      providerCustomerId: true,
      providerDevMode: true,

      externalId: true,
      metadataJson: true,

      paidAt: true,
      paidAmountCents: true,
      feeCents: true,
      paidMethod: true,

      createdAt: true,
      updatedAt: true,
    },
  });

  return res.json({ items });
}

// POST /api/admin/tenants/:id/override
// body: { enabled:true, plan:"PRO"|"PREMIUM", endsAt?:ISO, reason?:string }
async function setTenantOverride(req, res) {
  const id = String(req.params?.id || "").trim();
  if (!id) return res.status(400).json({ message: "Informe o id do tenant." });

  const enabled = !!req.body?.enabled;
  const plan = toUpper(req.body?.plan);
  const reason = String(req.body?.reason || "").trim() || null;
  const endsAtRaw = req.body?.endsAt;

  if (!enabled) {
    return res.status(400).json({ message: "enabled deve ser true. Para remover, use /override/remove." });
  }
  if (!["PRO", "PREMIUM"].includes(plan)) {
    return res.status(400).json({ message: "plan inválido (PRO/PREMIUM)." });
  }

  let endsAt = null;
  if (endsAtRaw) {
    const d = new Date(endsAtRaw);
    if (String(d) === "Invalid Date") return res.status(400).json({ message: "endsAt inválido." });
    endsAt = d;
  }

  const salon = await prisma.salon.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!salon) return res.status(404).json({ message: "Tenant não encontrado." });

  const updated = await prisma.salon.update({
    where: { id },
    data: {
      planOverrideEnabled: true,
      planOverridePlan: plan,
      planOverrideEndsAt: endsAt,
      planOverrideReason: reason,
    },
    select: {
      id: true,
      name: true,
      planOverrideEnabled: true,
      planOverridePlan: true,
      planOverrideEndsAt: true,
      planOverrideReason: true,
    },
  });

  await logAdminAction(req, "ADMIN_TENANT_OVERRIDE_SET", id, {
    plan,
    endsAt,
    reason,
  });

  return res.json({ ok: true, tenant: updated });
}

// POST /api/admin/tenants/:id/override/remove
async function removeTenantOverride(req, res) {
  const id = String(req.params?.id || "").trim();
  if (!id) return res.status(400).json({ message: "Informe o id do tenant." });

  const salon = await prisma.salon.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!salon) return res.status(404).json({ message: "Tenant não encontrado." });

  const updated = await prisma.salon.update({
    where: { id },
    data: {
      planOverrideEnabled: false,
      planOverridePlan: null,
      planOverrideEndsAt: null,
      planOverrideReason: null,
    },
    select: {
      id: true,
      name: true,
      planOverrideEnabled: true,
      planOverridePlan: true,
      planOverrideEndsAt: true,
      planOverrideReason: true,
    },
  });

  await logAdminAction(req, "ADMIN_TENANT_OVERRIDE_REMOVE", id, null);

  return res.json({ ok: true, tenant: updated });
}

// POST /api/admin/tenants/:id/extend
// body: { days: 7|30, reason?:string }
async function extendTenant(req, res) {
  const id = String(req.params?.id || "").trim();
  if (!id) return res.status(400).json({ message: "Informe o id do tenant." });

  const days = clampInt(req.body?.days, 1, 365, 30);
  if (![7, 30].includes(days)) {
    return res.status(400).json({ message: "days inválido. Use 7 ou 30." });
  }

  const reason = String(req.body?.reason || "").trim() || null;

  const salon = await prisma.salon.findUnique({
    where: { id },
    select: { id: true, planEndsAt: true, planStatus: true },
  });

  if (!salon) return res.status(404).json({ message: "Tenant não encontrado." });

  const now = new Date();
  const currentEnds = salon.planEndsAt ? new Date(salon.planEndsAt) : null;
  const base = currentEnds && currentEnds > now ? currentEnds : now;
  const newEndsAt = addDays(base, days);

  const updated = await prisma.salon.update({
    where: { id },
    data: {
      planStatus: "ACTIVE",
      planEndsAt: newEndsAt,
    },
    select: {
      id: true,
      name: true,
      plan: true,
      planStatus: true,
      planEndsAt: true,
      cancelAtPeriodEnd: true,
    },
  });

  await logAdminAction(req, "ADMIN_TENANT_EXTEND", id, { days, newEndsAt, reason });

  return res.json({ ok: true, tenant: updated });
}

// GET /api/admin/metrics
async function metrics(req, res) {
  const now = new Date();
  const in7 = addDays(now, 7);

  const overrideActiveWhere = {
    planOverrideEnabled: true,
    OR: [{ planOverrideEndsAt: null }, { planOverrideEndsAt: { gte: now } }],
  };

  const activeWhere = {
    OR: [
      overrideActiveWhere,
      {
        AND: [
          { planStatus: "ACTIVE" },
          { cancelAtPeriodEnd: false },
          { OR: [{ planEndsAt: null }, { planEndsAt: { gte: now } }] },
          { OR: [{ planEndsAt: null }, { planEndsAt: { gt: in7 } }] },
          { NOT: overrideActiveWhere },
        ],
      },
    ],
  };

  const expiringWhere = {
    AND: [
      { planStatus: "ACTIVE" },
      { cancelAtPeriodEnd: false },
      { planEndsAt: { gte: now, lte: in7 } },
      { NOT: overrideActiveWhere },
    ],
  };

  const cancelScheduledWhere = {
    AND: [
      { planStatus: "ACTIVE" },
      { cancelAtPeriodEnd: true },
      { OR: [{ planEndsAt: null }, { planEndsAt: { gte: now } }] },
      { NOT: overrideActiveWhere },
    ],
  };

  const inactiveWhere = {
    AND: [
      { OR: [{ planStatus: { not: "ACTIVE" } }, { planEndsAt: { lt: now } }] },
      { NOT: overrideActiveWhere },
    ],
  };

  const from30 = addDays(now, -30);

  const [
    totalTenants,
    activeTenants,
    expiringTenants,
    cancelScheduledTenants,
    inactiveTenants,
    revenueAgg,
    paidCount30d,
  ] = await Promise.all([
    prisma.salon.count(),
    prisma.salon.count({ where: activeWhere }),
    prisma.salon.count({ where: expiringWhere }),
    prisma.salon.count({ where: cancelScheduledWhere }),
    prisma.salon.count({ where: inactiveWhere }),
    prisma.saasBilling.aggregate({
      where: { status: "PAID", paidAt: { gte: from30 } },
      _sum: { amountCents: true },
    }),
    prisma.saasBilling.count({
      where: { status: "PAID", paidAt: { gte: from30 } },
    }),
  ]);

  return res.json({
    totalTenants,
    activeTenants,
    expiringTenants,
    cancelScheduledTenants,
    inactiveTenants,
    revenue30dCents: revenueAgg?._sum?.amountCents || 0,
    paidCount30d,
  });
}

module.exports = {
  listTenants,
  getTenant,
  listTenantBillings,
  setTenantOverride,
  removeTenantOverride,
  extendTenant,
  metrics,
};