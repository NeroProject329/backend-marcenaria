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
const meRoutes = require("./routes/me.routes");
const ordersRoutes = require("./routes/orders.routes");
const receivablesRoutes = require("./routes/receivables.routes");
const payablesRoutes = require("./routes/payables.routes");
const costsRoutes = require("./routes/costs.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const budgetsRoutes = require("./routes/budgets.routes");
const materialsRoutes = require("./routes/materials.routes");


const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/services", servicesRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/appointments", appointmentsRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/me", meRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/receivables", receivablesRoutes);
app.use("/api/payables", payablesRoutes);
app.use("/api/costs", costsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/budgets", budgetsRoutes);
app.use("/api/materials", materialsRoutes);




module.exports = { app };
