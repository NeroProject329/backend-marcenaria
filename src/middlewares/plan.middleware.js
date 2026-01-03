const { prisma } = require("../lib/prisma");

const PLAN_ORDER = ["FREE", "PRO", "PREMIUM"];

const LIMITS = {
  FREE: {
    services: 10,
    clients: 100,
    appointmentsMonth: 200,
    finance: false,
  },
  PRO: {
    services: 50,
    clients: 2000,
    appointmentsMonth: 2000,
    finance: true,
  },
  PREMIUM: {
    services: 999999,
    clients: 999999,
    appointmentsMonth: 999999,
    finance: true,
  },
};

function planAtLeast(current, required) {
  const a = PLAN_ORDER.indexOf(String(current || "FREE").toUpperCase());
  const b = PLAN_ORDER.indexOf(String(required || "FREE").toUpperCase());
  return a >= b;
}

async function loadSalonPlan(salonId) {
  return prisma.salon.findUnique({
    where: { id: salonId },
    select: { plan: true, planStatus: true, planEndsAt: true, trialEndsAt: true },
  });
}

// ✅ exige plano mínimo
function requirePlan(minPlan = "FREE") {
  return async (req, res, next) => {
    try {
      const { salonId } = req.user;
      const salon = await loadSalonPlan(salonId);

      if (!salon) return res.status(404).json({ message: "Salão não encontrado." });

      // status
      if (salon.planStatus && salon.planStatus !== "ACTIVE") {
        return res.status(402).json({ message: "Assinatura inativa. Regularize para continuar." });
      }

      // expiração (se você usar planEndsAt)
      if (salon.planEndsAt && new Date(salon.planEndsAt) < new Date()) {
        return res.status(402).json({ message: "Assinatura expirada. Renove para continuar." });
      }

      if (!planAtLeast(salon.plan, minPlan)) {
        return res.status(403).json({ message: `Recurso disponível a partir do plano ${minPlan}.` });
      }

      req.plan = String(salon.plan || "FREE").toUpperCase();
      next();
    } catch (e) {
      return res.status(500).json({ message: "Erro ao validar plano." });
    }
  };
}

// ✅ limita por quantidade (services/clients) e agendamentos por mês
function checkLimit(kind) {
  return async (req, res, next) => {
    try {
      const { salonId } = req.user;
      const salon = await loadSalonPlan(salonId);
      if (!salon) return res.status(404).json({ message: "Salão não encontrado." });

      const plan = String(salon.plan || "FREE").toUpperCase();
      const conf = LIMITS[plan] || LIMITS.FREE;

      // finance gate (opcional)
      if (kind === "finance") {
        if (!conf.finance) return res.status(403).json({ message: "Financeiro disponível apenas no Pro." });
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
    } catch (e) {
      return res.status(500).json({ message: "Erro ao validar limites do plano." });
    }
  };
}

module.exports = { requirePlan, checkLimit, LIMITS };
