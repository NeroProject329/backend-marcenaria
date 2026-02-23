const { prisma } = require("../lib/prisma");

/**
 * GET /api/settings
 */
async function getSettings(req, res) {
  const { salonId } = req.user;

  const salon = await prisma.salon.findUnique({
  where: { id: salonId },
  select: {
    id: true,
    name: true,
    phone: true,
    address: true,
    logoUrl: true,

    openTime: true,
    closeTime: true,
    workingDays: true,
    blockOutsideHours: true,

    owner: { select: { id: true, name: true, email: true, phone: true } },
  },
});


  if (!salon) {
    return res.status(404).json({ message: "Salão não encontrado." });
  }

 return res.json({
  settings: {
    openTime: salon.openTime,
    closeTime: salon.closeTime,
    workingDays: salon.workingDays,
    blockOutsideHours: salon.blockOutsideHours,
  },
  salon: {
    name: salon.name,
    phone: salon.phone,
    address: salon.address,
    logoUrl: salon.logoUrl,
  },
  user: salon.owner
    ? { id: salon.owner.id, name: salon.owner.name, email: salon.owner.email, phone: salon.owner.phone }
    : null,
});

}
  
/**
 * PATCH /api/settings
 */
async function updateSettings(req, res) {
  const { salonId } = req.user;
  const { settings, salon } = req.body;

  await prisma.salon.update({
    where: { id: salonId },
    data: {
      // Configurações
      openTime: settings?.openTime,
      closeTime: settings?.closeTime,
      workingDays: settings?.workingDays,
      blockOutsideHours: settings?.blockOutsideHours ?? false,

      // Infos do salão
      name: salon?.name,
      phone: salon?.phone,
      address: salon?.address,
    },
  });

  return res.json({ success: true });
}

module.exports = {
  getSettings,
  updateSettings,
};
