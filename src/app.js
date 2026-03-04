require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const servicesRoutes = require("./routes/services.routes");
const clientsRoutes = require("./routes/clients.routes");
const appointmentsRoutes = require("./routes/appointments.routes");
const financeRoutes = require("./routes/finance.routes");
const settingsRoutes = require("./routes/settings.routes");
const adminRoutes = require("./routes/admin.routes");
const adminAuthRoutes = require("./routes/adminAuth.routes"); // ✅ NOVO
const meRoutes = require("./routes/me.routes");
const ordersRoutes = require("./routes/orders.routes");
const receivablesRoutes = require("./routes/receivables.routes");
const payablesRoutes = require("./routes/payables.routes");
const costsRoutes = require("./routes/costs.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const budgetsRoutes = require("./routes/budgets.routes");
const materialsRoutes = require("./routes/materials.routes");
const { prisma } = require("./lib/prisma");
const jwt = require("jsonwebtoken");

// ✅ NOVO: Funcionários
const employeesRoutes = require("./routes/employees.routes");

// ✅ NOVO
const reportsRoutes = require("./routes/reports.routes");

const reportsExtraRoutes = require("./routes/reportsExtra.routes");

// ✅ SAAS-P2: Billing (checkout AbacatePay)
const billingRoutes = require("./routes/billing.routes");

// ✅ SAAS-P3 Webhooks (RAW)
const webhooksRoutes = require("./routes/webhooks.routes");


const app = express();
app.use(cors());

app.use("/api/webhooks", webhooksRoutes);

app.use(express.json());


// ✅ Guard global: bloqueia SaaS expirado (mas deixa auth/billing/webhooks/me/admin)
app.use("/api", async (req, res, next) => {
  try {
    const p = req.path || "";

    // allowlist
    if (
      p.startsWith("/auth") ||
      p.startsWith("/billing") ||
      p.startsWith("/webhooks") ||
      p.startsWith("/me") ||
      p.startsWith("/admin")
    ) {
      return next();
    }

    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Sem token" });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Token inválido" });
    }

    // mantém compatibilidade com middlewares já existentes
    req.user = payload; // { userId, salonId }

    const salonId = payload?.salonId;
    if (!salonId) return res.status(401).json({ message: "Sem salonId no token" });

    const salon = await prisma.salon.findUnique({
      where: { id: salonId },
      select: {
        planStatus: true,
        planEndsAt: true,

        cancelAtPeriodEnd: true,

        planOverrideEnabled: true,
        planOverridePlan: true,
        planOverrideEndsAt: true,
      },
    });

    if (!salon) return res.status(404).json({ message: "Salão não encontrado." });

    const now = new Date();

    // override tem prioridade
    if (salon.planOverrideEnabled) {
      const ends = salon.planOverrideEndsAt ? new Date(salon.planOverrideEndsAt) : null;
      if (!ends || ends >= now) return next();
    }

    // status (cancelAtPeriodEnd não bloqueia)
    if (salon.planStatus && String(salon.planStatus).toUpperCase() !== "ACTIVE") {
      return res.status(402).json({ message: "Assinatura inativa. Regularize para continuar." });
    }

    if (salon.planEndsAt && new Date(salon.planEndsAt) < now) {
      return res.status(402).json({ message: "Assinatura expirada. Renove para continuar." });
    }

    return next();
  } catch {
    return res.status(500).json({ message: "Erro ao validar acesso do SaaS." });
  }
});


app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/services", servicesRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/appointments", appointmentsRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/admin/auth", adminAuthRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/me", meRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/receivables", receivablesRoutes);
app.use("/api/payables", payablesRoutes);
app.use("/api/costs", costsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/budgets", budgetsRoutes);
app.use("/api/materials", materialsRoutes);

// ✅ NOVO: endpoint do módulo Funcionários
app.use("/api/employees", employeesRoutes);





// ✅ NOVO
app.use("/api/reports", reportsRoutes);

app.use("/api/reports", reportsExtraRoutes);

// ✅ SAAS-P2
app.use("/api/billing", billingRoutes);

module.exports = { app };