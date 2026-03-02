const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  overview,
  upcomingPayments,
  weekSummary,
} = require("../controllers/dashboard.controller");

router.use(requireAuth);

// Dashboard completo (KPIs + próximas entregas + resumo semanal)
router.get("/overview", overview);

// Widget: Próximos Pagamentos (7/15 dias)
router.get("/upcoming-payments", upcomingPayments);

// Resumo da semana (a pagar / a receber)
router.get("/week-summary", weekSummary);

module.exports = router;