const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");

const {
  listBudgets,
  getBudget,
  createBudget,
  updateBudget,
  updateBudgetFull,
  sendBudget,
  approveBudget,
  cancelBudget,
  deleteBudget,
} = require("../controllers/budgets.controller");

router.use(requireAuth);

router.get("/", listBudgets);
router.get("/:id", getBudget);
router.post("/", createBudget);

// update simples (status/observações/previsão)
router.patch("/:id", updateBudget);

// update completo (itens + pagamento + parcelas custom)
router.patch("/:id/full", updateBudgetFull);

// ações de negócio
router.post("/:id/send", sendBudget);
router.post("/:id/approve", approveBudget);
router.post("/:id/cancel", cancelBudget);

// opcional
router.delete("/:id", deleteBudget);

module.exports = router;
