const router = require("express").Router();
const { prisma } = require("../lib/prisma");
const { requireAuth } = require("../middlewares/auth.middleware");
const { requireAdminSecret } = require("../middlewares/admin.middleware");

/**
 * POST /api/admin/dev/upgrade-pro
 * Headers: x-admin-secret: <ADMIN_SECRET>
 * Body opcional:
 *  - { salonId: "..." }   -> promove um salão específico
 *  - se não enviar, promove o salão do usuário logado
 */
router.post("/dev/upgrade-pro", requireAuth, requireAdminSecret, async (req, res) => {
  const targetSalonId = req.body?.salonId || req.user?.salonId;

  if (!targetSalonId) {
    return res.status(400).json({ message: "salonId não encontrado." });
  }

  const salon = await prisma.salon.findUnique({
    where: { id: targetSalonId },
    select: { id: true, plan: true, planStatus: true },
  });

  if (!salon) {
    return res.status(404).json({ message: "Salão não encontrado." });
  }

  await prisma.salon.update({
    where: { id: targetSalonId },
    data: {
      plan: "PRO",
      planStatus: "ACTIVE",
      planEndsAt: null,
      trialEndsAt: null,
    },
  });

  return res.json({ ok: true, salonId: targetSalonId, plan: "PRO" });
});

/**
 * POST /api/admin/dev/set-plan
 * Headers: x-admin-secret: <ADMIN_SECRET>
 * Body: { salonId?, plan: "FREE"|"PRO"|"PREMIUM" }
 */
router.post("/dev/set-plan", requireAuth, requireAdminSecret, async (req, res) => {
  const targetSalonId = req.body?.salonId || req.user?.salonId;
  const plan = String(req.body?.plan || "").toUpperCase();

  if (!["FREE", "PRO", "PREMIUM"].includes(plan)) {
    return res.status(400).json({ message: "Plan inválido (FREE/PRO/PREMIUM)." });
  }

  await prisma.salon.update({
    where: { id: targetSalonId },
    data: { plan, planStatus: "ACTIVE" },
  });

  return res.json({ ok: true, salonId: targetSalonId, plan });
});

module.exports = router;
