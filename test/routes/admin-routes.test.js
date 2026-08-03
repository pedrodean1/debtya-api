const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const {
  adminAccessConfigured,
  isAdminUser,
  registerAdminRoutes
} = require("../../routes/admin-routes");
const { jsonError } = require("../../lib/json-error");

function requireUserAs(user) {
  return (req, res, next) => {
    if (!user) return jsonError(res, 401, "Unauthorized");
    req.user = user;
    next();
  };
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

function makeApp({ user, supabaseAdmin } = {}) {
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app, {
    requireUser: requireUserAs(user),
    supabaseAdmin: supabaseAdmin || makeDiagnosticsSupabase(),
    jsonError,
    safeNumber: Number,
    appDebug: () => {},
    SERVER_VERSION: "test-admin-version"
  });
  return app;
}

function withAdminEnv(env, fn) {
  const prevEmails = process.env.DEBTYA_ADMIN_EMAILS;
  const prevUserIds = process.env.DEBTYA_ADMIN_USER_IDS;
  process.env.DEBTYA_ADMIN_EMAILS = env.DEBTYA_ADMIN_EMAILS || "";
  process.env.DEBTYA_ADMIN_USER_IDS = env.DEBTYA_ADMIN_USER_IDS || "";
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevEmails == null) delete process.env.DEBTYA_ADMIN_EMAILS;
      else process.env.DEBTYA_ADMIN_EMAILS = prevEmails;
      if (prevUserIds == null) delete process.env.DEBTYA_ADMIN_USER_IDS;
      else process.env.DEBTYA_ADMIN_USER_IDS = prevUserIds;
    });
}

describe("routes/admin diagnostics", () => {
  it("detecta admins solo por allowlist del servidor", () => {
    const env = {
      DEBTYA_ADMIN_EMAILS: " owner@example.com, ops@example.com ",
      DEBTYA_ADMIN_USER_IDS: "user-123"
    };
    assert.equal(adminAccessConfigured(env), true);
    assert.equal(isAdminUser({ email: "OWNER@example.com" }, env), true);
    assert.equal(isAdminUser({ id: "user-123", email: "person@example.com" }, env), true);
    assert.equal(isAdminUser({ id: "other", email: "person@example.com" }, env), false);
    assert.equal(isAdminUser({ email: "owner@example.com" }, {}), false);
  });

  it("rechaza usuario autenticado que no esta en allowlist", async () => {
    await withAdminEnv({ DEBTYA_ADMIN_EMAILS: "owner@example.com" }, async () => {
      const app = makeApp({ user: { id: "user-2", email: "person@example.com" } });
      const res = await request(app).get("/api/admin/diagnostics");
      assert.equal(res.status, 403);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.details, "admin_forbidden");
    });
  });

  it("devuelve diagnostico agregado para admin sin exponer ids ni emails", async () => {
    await withAdminEnv({ DEBTYA_ADMIN_EMAILS: "owner@example.com" }, async () => {
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
            event_type: "minimum_payment_due",
            channel: "email",
            created_at: new Date().toISOString(),
            metadata: { delivery_status: "failed", email: "person@example.com" }
          }
        ]
      });
      const app = makeApp({ user: { id: "user-1", email: "owner@example.com" }, supabaseAdmin });
      const res = await request(app).get("/api/admin/diagnostics?days=14&limit=50");

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.server_version, "test-admin-version");
      assert.equal(res.body.lookback_days, 14);
      assert.equal(res.body.row_limit, 50);
      assert.equal(res.body.debts.active_carrying_count, 1);
      assert.equal(res.body.debts.paid_or_paid_off_count, 1);
      assert.equal(res.body.payment_intents.open_count, 1);
      assert.equal(res.body.payment_intents.executed_count, 1);
      assert.equal(res.body.payment_intents.payment_recorded_email_sent_count, 1);
      assert.equal(res.body.payment_intents.debt_paid_celebration_email_sent_count, 1);
      assert.equal(res.body.notification_events.minimum_payment_due.failed_count, 1);
      assert.ok(res.body.alerts.includes("recent_minimum_payment_due_email_failures"));

      const serialized = JSON.stringify(res.body);
      assert.equal(serialized.includes(userId), false);
      assert.equal(serialized.includes(debtId), false);
      assert.equal(serialized.includes(intentId), false);
      assert.equal(serialized.includes("person@example.com"), false);
    });
  });
});
