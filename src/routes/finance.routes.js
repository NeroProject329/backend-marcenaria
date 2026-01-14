const express = require("express");
const { requireAuth } = require("../middlewares/auth.middleware");
const { checkLimit } = require("../middlewares/plan.middleware");

const {
  financeSummary,
  financeFlow,
  financeCashflow,        // ✅ add
  receivablesByMonth,     // ✅ add
  payablesByMonth,        // ✅ add
  listCategories,
  createCategory,
  listTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
} = require("../controllers/finance.controller");

const router = express.Router();

router.use(requireAuth);

// ✅ já existia
router.get("/summary", checkLimit("finance"), financeSummary);

// ✅ NOVO: fluxo de caixa (PDF)
router.get("/flow", checkLimit("finance"), financeFlow);

// ✅ NOVO: categorias
router.get("/categories", checkLimit("finance"), listCategories);
router.post("/categories", checkLimit("finance"), createCategory);

// ✅ NOVO: lançamentos
router.get("/transactions", checkLimit("finance"), listTransactions);
router.post("/transactions", checkLimit("finance"), createTransaction);
router.patch("/transactions/:id", checkLimit("finance"), updateTransaction);
router.delete("/transactions/:id", checkLimit("finance"), deleteTransaction);

// ✅ NOVO: fluxo de caixa com saldo anterior (Marcenaria)
router.get("/cashflow", checkLimit("finance"), financeCashflow);

// ✅ NOVO: recebimentos por mês (parcelas)
router.get("/receivables/month", checkLimit("finance"), receivablesByMonth);

// ✅ NOVO: pagamentos por mês (parcelas)
router.get("/payables/month", checkLimit("finance"), payablesByMonth);

module.exports = router;
