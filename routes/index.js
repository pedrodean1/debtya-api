const { registerCoreRoutes } = require("./core-routes");
const { registerPaymentIntentRoutes } = require("./payment-intents-routes");
const { registerPlanningRoutes } = require("./planning-routes");
const { registerGuideRoutes } = require("./guide-routes");
const { registerBillingRoutes } = require("./billing-routes");
const { registerSupabaseRoutes } = require("./supabase-routes");
const { registerPlaidRoutes } = require("./plaid-routes");
const { registerMethodRoutes } = require("./method-routes");
const { registerAccountsDebtsRoutes } = require("./accounts-debts-routes");
const { registerPaymentPlansRoutes } = require("./payment-plans-routes");
const { registerRulesCrudRoutes } = require("./rules-crud-routes");
const { registerStrategyRoutes } = require("./strategy-routes");
const { registerCronRoutes } = require("./cron-routes");
const { registerAuthSignupRoutes } = require("./auth-signup-routes");

/**
 * Registra todas las rutas HTTP modulares en el orden previo al refactor.
 * Cada modulo solo usa las claves que necesita del objeto deps.
 */
function registerAllRoutes(app, deps) {
  registerCoreRoutes(app, deps);
  registerPaymentIntentRoutes(app, deps);
  registerPlanningRoutes(app, deps);
  registerGuideRoutes(app, deps);
  registerAuthSignupRoutes(app, deps);
  registerBillingRoutes(app, deps);
  registerSupabaseRoutes(app, deps);
  registerPlaidRoutes(app, deps);
  registerMethodRoutes(app, deps);
  registerAccountsDebtsRoutes(app, deps);
  registerPaymentPlansRoutes(app, deps);
  registerRulesCrudRoutes(app, deps);
  registerStrategyRoutes(app, deps);
  registerCronRoutes(app, deps);
}

module.exports = { registerAllRoutes };
