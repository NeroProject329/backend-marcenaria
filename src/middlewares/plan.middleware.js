// src/middlewares/plan.middleware.js
const { prisma } = require("../lib/prisma");

const PLAN_ORDER = ["FREE", "PRO", "PREMIUM"];

const LIMITS = {
  FREE: { services: 10, clients: 100, appointmentsMonth: 200, finance: false },
  PRO: { services: 50, clients: 2000, appointmentsMonth: 2000, finance: true },
  PREMIUM: { services: 999999, clients: 999999, appointmentsMonth: 999999, finance: true },
};

function planAtLeast(current, required) {
  const a = PLAN_ORDER.indexOf(String(current || "FREE").toUpperCase());
  const b = PLAN_ORDER.indexOf(String(required || "FREE").toUpperCase());
  return a >= b;
}

async function loadSalonPlan(salonId) {
  return prisma.salon.findUnique({
    where: { id: salonId },
    select: {
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
    },
  });
}

function resolveAccess(salon) {
  const now = new Date();

  const basePlan = String(salon?.plan || "FREE").toUpperCase();
  const planStatus = String(salon?.planStatus || "ACTIVE").toUpperCase();

  // ✅ Override tem prioridade total
  const overrideEnabled = !!salon?.planOverrideEnabled;
  const overridePlan = String(salon?.planOverridePlan || basePlan).toUpperCase();
  const overrideEndsAt = salon?.planOverrideEndsAt ? new Date(salon.planOverrideEndsAt) : null;

  const overrideActive = overrideEnabled && (!overrideEndsAt || overrideEndsAt >= now);

  if (overrideActive) {
    return {
      ok: true,
      plan: overridePlan,
      source: "OVERRIDE",
      endsAt: overrideEndsAt,
      cancelAtPeriodEnd: false,
    };
  }

  // (trial se existir e estiver ativo, libera — sem inventar plano novo)
  const trialEndsAt = salon?.trialEndsAt ? new Date(salon.trialEndsAt) : null;
  const trialActive = !!trialEndsAt && trialEndsAt >= now;

  // status
  if (!trialActive && planStatus !== "ACTIVE") {
    return { ok: false, code: 402, message: "Assinatura inativa. Regularize para continuar." };
  }

  // expiração
  const endsAt = salon?.planEndsAt ? new Date(salon.planEndsAt) : null;
  if (!trialActive && endsAt && endsAt < now) {
    return { ok: false, code: 402, message: "Assinatura expirada. Renove para continuar." };
  }

  return {
    ok: true,
    plan: basePlan,
    source: trialActive ? "TRIAL" : "SUBSCRIPTION",
    endsAt,
    cancelAtPeriodEnd: !!salon?.cancelAtPeriodEnd,
  };
}

// ✅ exige plano mínimo (mas também valida expiração/override)
function requirePlan(minPlan = "FREE") {
  return async (req, res, next) => {
    try {
      const { salonId } = req.user;
      const salon = await loadSalonPlan(salonId);
      if (!salon) return res.status(404).json({ message: "Salão não encontrado." });

      const access = resolveAccess(salon);
      if (!access.ok) return res.status(access.code || 402).json({ message: access.message });

      if (!planAtLeast(access.plan, minPlan)) {
        return res.status(403).json({ message: `Recurso disponível a partir do plano ${minPlan}.` });
      }

      req.plan = access.plan;
      req.planAccess = access;
      return next();
    } catch {
      return res.status(500).json({ message: "Erro ao validar plano." });
    }
  };
}

// ✅ limita por quantidade + também valida expiração/override
function checkLimit(kind) {
  return async (req, res, next) => {
    try {
      const { salonId } = req.user;

      const salon = await loadSalonPlan(salonId);
      if (!salon) return res.status(404).json({ message: "Salão não encontrado." });

      const access = resolveAccess(salon);
      if (!access.ok) return res.status(access.code || 402).json({ message: access.message });

      const plan = access.plan;
      const conf = LIMITS[plan] || LIMITS.FREE;

      req.plan = plan;
      req.planAccess = access;

      if (kind === "finance") {
        if (!conf.finance) {
          return res.status(403).json({ message: "Financeiro disponível apenas no Pro." });
        }
        return next();
      }

      if (kind === "services") {
        const count = await prisma.service.count({ where: { salonId } });
        if (count >= conf.services) {
          return res.status(403).json({ message: `Limite do plano atingido: serviços (${conf.services}).` });
        }
        return next();
      }

      if (kind === "clients") {
        const count = await prisma.client.count({ where: { salonId } });
        if (count >= conf.clients) {
          return res.status(403).json({ message: `Limite do plano atingido: clientes (${conf.clients}).` });
        }
        return next();
      }

      if (kind === "appointmentsMonth") {
        const now = new Date();
        const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        const to = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);

        const count = await prisma.appointment.count({
          where: { salonId, startAt: { gte: from, lt: to } },
        });

        if (count >= conf.appointmentsMonth) {
          return res.status(403).json({
            message: `Limite do plano atingido: agendamentos no mês (${conf.appointmentsMonth}).`,
          });
        }
        return next();
      }

      return next();
    } catch {
      return res.status(500).json({ message: "Erro ao validar limites do plano." });
    }
  };
}

module.exports = { requirePlan, checkLimit, LIMITS };