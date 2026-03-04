// src/routes/admin.routes.js
const router = require("express").Router();
const { prisma } = require("../lib/prisma");
const { requireAdminAuth } = require("../middlewares/adminAuth.middleware");

/**
 * Rotas internas do painel Admin (SaaS)
 * Tudo aqui exige admin autenticado.
 */
router.use(requireAdminAuth);

const {
  listTenants,
  getTenant,
  listTenantBillings,
  setTenantOverride,
  removeTenantOverride,
  extendTenant,
  metrics,
} = require("../controllers/adminTenants.controller");

/**
 * Rotas internas do painel Admin (SaaS)
 * Tudo aqui exige admin autenticado.
 */
router.use(requireAdminAuth);

// --------- Metrics ----------
router.get("/metrics", metrics);

// --------- Tenants ----------
router.get("/tenants", listTenants);
router.get("/tenants/:id", getTenant);
router.get("/tenants/:id/billings", listTenantBillings);

router.post("/tenants/:id/override", setTenantOverride);
router.post("/tenants/:id/override/remove", removeTenantOverride);
router.post("/tenants/:id/extend", extendTenant);


router.post("/dev/set-plan", async (req, res) => {
  const targetSalonId = req.body?.salonId;
  const plan = String(req.body?.plan || "").toUpperCase();

  if (!targetSalonId) return res.status(400).json({ message: "Informe salonId." });
  if (!["FREE", "PRO", "PREMIUM"].includes(plan)) {
    return res.status(400).json({ message: "Plan inválido (FREE/PRO/PREMIUM)." });
  }

  await prisma.salon.update({
    where: { id: targetSalonId },
    data: { plan, planStatus: "ACTIVE" },
  });

  // audita
  await prisma.adminActionLog.create({
    data: {
      adminUserId: req.admin.id,
      action: "ADMIN_DEV_SET_PLAN",
      targetSalonId: targetSalonId,
      detailsJson: JSON.stringify({ plan }),
      ip: String(req.headers["x-forwarded-for"] || req.ip || ""),
      userAgent: String(req.headers["user-agent"] || ""),
    },
  });

  return res.json({ ok: true, salonId: targetSalonId, plan });
});

module.exports = router;