const router = require("express").Router();
const { requireAuth } = require("../middlewares/auth.middleware");
const {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} = require("../controllers/employees.controller");

router.use(requireAuth);

router.get("/", listEmployees);
router.post("/", createEmployee);
router.get("/:id", getEmployee);
router.patch("/:id", updateEmployee);
router.delete("/:id", deleteEmployee);

module.exports = router;