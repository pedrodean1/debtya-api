const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { registerCronRoutes } = require("../../routes/cron-routes");
const { jsonError } = require("../../lib/json-error");

function requireCronSecretLikeServer(req, res, next) {
  const provided = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET) return jsonError(res, 500, "CRON_SECRET no configurado");
  if (!provided || provided !== process.env.CRON_SECRET) return jsonError(res, 401, "Unauthorized");
  next();
}

function makeApp(overrides = {}) {
  const app = express();
  app.use(express.json());
  registerCronRoutes(app, {
    requireCronSecret: requireCronSecretLikeServer,
    supabaseAdmin: overrides.supabaseAdmin || {
      from() {
        return {
          select() {
            return { eq() { return Promise.resolve({ data: [], error: null }); } };
          }
        };
      }
    },
    jsonError,
    callRpc: async () => null,
    approveIntentDirect: async () => null,
    executeIntentDirect: async () => null,
    getIntentAmount: () => 0,
    isUuid: () => true,
    safeNumber: Number,
    getCurrentPaymentPlan: async () => null,
    stampRecentIntentsFundingFromPlan: async () => null,
    applyExecutedIntentToDebt: overrides.applyExecutedIntentToDebt || (async () => ({ ok: true, skipped: false })),
    reconcileManualFirstPriorityIntent: async () => null,
    appDebug: () => {},
    SERVER_VERSION: "test-version",
    SUPABASE_URL: "x",
    SUPABASE_ANON_KEY: "x",
    SUPABASE_SERVICE_ROLE_KEY: "x",
    CRON_SECRET: process.env.CRON_SECRET,
    ...overrides
  });
  return app;
}

function makeDiagnosticsSupabase(rowsByTable = {}) {
  return {
    from(table) {
      const rows = Array.isArray(rowsByTable[table]) ? [...rowsByTable[table]] : [];
      const query = {
        _rows: rows,
        select() {
          return this;
        },
        gte(column, value) {
          this._rows = this._rows.filter((row) => {
            const raw = row?.[column];
            return raw && String(raw) >= String(value);
          });
          return this;
        },
        order() {
          return this;
        },
        limit(n) {
          return Promise.resolve({ data: this._rows.slice(0, Number(n) || 1000), error: null });
        }
      };
      return query;
    }
  };
}

describe("routes/cron minimum payment auto tracking", () => {
  it("protege /cron/system-diagnostics con x-cron-secret", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-diagnostics-test";
    try {
      const app = makeApp();
      const res = await request(app).get("/cron/system-diagnostics");
      assert.equal(res.status, 401);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("devuelve diagnostico interno agregado sin exponer ids ni emails", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-diagnostics-test";
    try {
      const userId = "550e8400-e29b-41d4-a716-446655440000";
      const debtId = "660e8400-e29b-41d4-a716-446655440000";
      const intentId = "770e8400-e29b-41d4-a716-446655440000";
      const supabaseAdmin = makeDiagnosticsSupabase({
        debts: [
          { id: debtId, user_id: userId, status: "active", balance: 120, is_active: true },
          { id: "paid-debt", user_id: userId, status: "paid", balance: 0, is_active: true }
        ],
        payment_intents: [
          {
            id: intentId,
            user_id: userId,
            debt_id: debtId,
            status: "pending_review",
            metadata: { payment_recorded_email_sent_at: "2026-08-01T00:00:00.000Z" }
          },
          {
            id: "executed-intent",
            user_id: userId,
            debt_id: debtId,
            status: "executed",
            executed_at: "2026-08-01T00:00:00.000Z",
            metadata: { debt_paid_celebration_email_sent_at: "2026-08-01T00:01:00.000Z" }
          }
        ],
        notification_events: [
          {
            id: "event-1",
            user_id: userId,
            intent_id: intentId,
            event_type: "auto_reminder",
            channel: "email",
            created_at: new Date().toISOString(),
            metadata: {}
          },
          {
            id: "event-2",
            user_id: userId,
            event_type: "minimum_payment_due",
            channel: "email",
            created_at: new Date().toISOString(),
            metadata: { delivery_status: "failed", email: "person@example.com" }
          }
        ]
      });
      const app = makeApp({ supabaseAdmin });
      const res = await request(app)
        .get("/cron/system-diagnostics?days=14&limit=50")
        .set("x-cron-secret", "cron-diagnostics-test");

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.server_version, "test-version");
      assert.equal(res.body.lookback_days, 14);
      assert.equal(res.body.row_limit, 50);
      assert.equal(res.body.debts.active_carrying_count, 1);
      assert.equal(res.body.debts.paid_or_paid_off_count, 1);
      assert.equal(res.body.payment_intents.open_count, 1);
      assert.equal(res.body.payment_intents.executed_count, 1);
      assert.equal(res.body.payment_intents.payment_recorded_email_sent_count, 1);
      assert.equal(res.body.notification_events.minimum_payment_due.failed_count, 1);
      assert.ok(res.body.alerts.includes("recent_minimum_payment_due_email_failures"));
      const serialized = JSON.stringify(res.body);
      assert.equal(serialized.includes(userId), false);
      assert.equal(serialized.includes(debtId), false);
      assert.equal(serialized.includes(intentId), false);
      assert.equal(serialized.includes("person@example.com"), false);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("protege /cron/cleanup-payment-intents con x-cron-secret", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-cleanup-test";
    try {
      const app = makeApp();
      const res = await request(app).post("/cron/cleanup-payment-intents").send({});
      assert.equal(res.status, 401);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("protege /cron/admin-diagnostics-alerts con x-cron-secret", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-admin-alert-test";
    try {
      const app = makeApp();
      const res = await request(app).post("/cron/admin-diagnostics-alerts").send({});
      assert.equal(res.status, 401);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("envia alerta admin desde cron cuando diagnostics esta en warning", async () => {
    const prevSecret = process.env.CRON_SECRET;
    const prevAdminEmails = process.env.DEBTYA_ADMIN_ALERT_EMAILS;
    const prevAdminBaseEmails = process.env.DEBTYA_ADMIN_EMAILS;
    const prevAuditUserId = process.env.DEBTYA_ADMIN_ALERT_AUDIT_USER_ID;
    process.env.CRON_SECRET = "cron-admin-alert-test";
    process.env.DEBTYA_ADMIN_ALERT_EMAILS = "owner@example.com";
    delete process.env.DEBTYA_ADMIN_EMAILS;
    delete process.env.DEBTYA_ADMIN_ALERT_AUDIT_USER_ID;
    try {
      const sends = [];
      const supabaseAdmin = makeDiagnosticsSupabase({
        debts: [{ id: "paid-debt", user_id: "secret-user", status: "paid", balance: 20, is_active: true }],
        payment_intents: [],
        notification_events: []
      });
      const app = makeApp({
        supabaseAdmin,
        sendEmailFn: async (args) => {
          sends.push(args);
          return { sent: true, provider: "test" };
        }
      });
      const res = await request(app)
        .post("/cron/admin-diagnostics-alerts")
        .set("x-cron-secret", "cron-admin-alert-test")
        .send({ limit: 50 });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.server_version, "test-version");
      assert.equal(res.body.overall_status, "warning");
      assert.equal(res.body.reason, "admin_alert_sent");
      assert.equal(res.body.sent_count, 1);
      assert.equal(res.body.failed_count, 0);
      assert.ok(res.body.alerts.includes("paid_debts_with_positive_balance"));
      assert.equal(sends.length, 1);
      assert.ok(sends[0].preview.email_body.includes("paid_debts_with_positive_balance"));
      assert.equal(JSON.stringify(res.body).includes("owner@example.com"), false);
      assert.equal(JSON.stringify(res.body).includes("secret-user"), false);
    } finally {
      if (prevSecret == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevSecret;
      if (prevAdminEmails == null) delete process.env.DEBTYA_ADMIN_ALERT_EMAILS;
      else process.env.DEBTYA_ADMIN_ALERT_EMAILS = prevAdminEmails;
      if (prevAdminBaseEmails == null) delete process.env.DEBTYA_ADMIN_EMAILS;
      else process.env.DEBTYA_ADMIN_EMAILS = prevAdminBaseEmails;
      if (prevAuditUserId == null) delete process.env.DEBTYA_ADMIN_ALERT_AUDIT_USER_ID;
      else process.env.DEBTYA_ADMIN_ALERT_AUDIT_USER_ID = prevAuditUserId;
    }
  });

  it("limpia intents abiertos de deudas pagadas con resumen seguro", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-cleanup-test";
    try {
      const userId = "550e8400-e29b-41d4-a716-446655440000";
      const debtId = "660e8400-e29b-41d4-a716-446655440000";
      const intentId = "770e8400-e29b-41d4-a716-446655440000";
      const updates = [];
      let selectedPaymentIntentColumns = "";
      const supabaseAdmin = {
        from(table) {
          if (table === "payment_intents") {
            return {
              select(columns) {
                selectedPaymentIntentColumns = columns;
                return {
                  in() {
                    return {
                      order() {
                        return {
                          limit() {
                            return Promise.resolve({
                              data: [
                                {
                                  id: intentId,
                                  user_id: userId,
                                  debt_id: debtId,
                                  status: "pending_review",
                                  metadata: {}
                                }
                              ],
                              error: null
                            });
                          }
                        };
                      }
                    };
                  }
                };
              },
              update(payload) {
                updates.push(payload);
                return {
                  eq() {
                    return {
                      eq() {
                        return {
                          in() {
                            return Promise.resolve({ error: null });
                          }
                        };
                      }
                    };
                  }
                };
              }
            };
          }
          if (table === "debts") {
            return {
              select() {
                return {
                  eq() {
                    return {
                      in() {
                        return Promise.resolve({
                          data: [{ id: debtId, user_id: userId, status: "paid", balance: 0, is_active: true }],
                          error: null
                        });
                      }
                    };
                  }
                };
              }
            };
          }
          throw new Error(`tabla inesperada ${table}`);
        }
      };
      const app = makeApp({ supabaseAdmin });
      const res = await request(app)
        .post("/cron/cleanup-payment-intents")
        .set("x-cron-secret", "cron-cleanup-test")
        .send({ limit: 50 });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.server_version, "test-version");
      assert.equal(res.body.limit, 50);
      assert.equal(res.body.users_scanned, 1);
      assert.equal(res.body.intents_scanned, 1);
      assert.equal(res.body.retired_count, 1);
      assert.deepEqual(res.body.reason_counts, { debt_paid: 1 });
      assert.equal(updates.length, 1);
      assert.equal(updates[0].status, "cancelled");
      assert.equal(updates[0].metadata.stale_intent_retired_reason, "debt_paid");
      assert.match(selectedPaymentIntentColumns, /\bdebt_id\b/);
      assert.doesNotMatch(selectedPaymentIntentColumns, /target_debt_id/);
      assert.equal(JSON.stringify(res.body).includes(userId), false);
      assert.equal(JSON.stringify(res.body).includes(intentId), false);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("protege /cron/track-minimum-payments con x-cron-secret", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-minimum-test";
    try {
      const app = makeApp();
      const res = await request(app).post("/cron/track-minimum-payments").send({});
      assert.equal(res.status, 401);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it("ejecuta sin usuarios elegibles y no falla", async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-minimum-test";
    try {
      const app = makeApp();
      const res = await request(app)
        .post("/cron/track-minimum-payments")
        .set("x-cron-secret", "cron-minimum-test")
        .send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.tracked, 0);
      assert.equal(res.body.users_checked, 0);
    } finally {
      if (prev == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });
});
