// scripts/create-admin.js
require("dotenv").config();
const bcrypt = require("bcrypt");
const { prisma } = require("../src/lib/prisma");

async function main() {
  const email = String(process.argv[2] || "").trim().toLowerCase();
  const password = String(process.argv[3] || "");

  if (!email || !password) {
    console.log("Uso: node scripts/create-admin.js email@dominio.com senha");
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  const existing = await prisma.adminUser.findUnique({ where: { email } });

  if (existing) {
    await prisma.adminUser.update({
      where: { email },
      data: { password: hash, isActive: true, mustChangePassword: false },
    });
    console.log("✅ Admin atualizado:", email);
  } else {
    await prisma.adminUser.create({
      data: { email, password: hash, isActive: true, mustChangePassword: false },
    });
    console.log("✅ Admin criado:", email);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("Erro:", e);
  process.exit(1);
});