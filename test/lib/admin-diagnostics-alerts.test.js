const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ADMIN_DIAGNOSTICS_ALERT_AUDIT_TYPE,
  buildAlertFingerprint,
  resolveAdminAlertRecipients,
  runAdminDiagnosticsAlert
} = require("../../lib/admin-diagnostics-alerts");

const auditUserId = "550e8400-e29b-41d4-a716-446655440000";

function makeSelectChain(rows) {
  const filters = [];
  let limitCount = null;
  const chain = {
    eq(key, value) {
      filters.push({ key, value });
      return chain;
    },
    gte(key, value) {
      filters.push({ key, value, op: "gte" });
      return chain;
    },
    order() {
      return chain;
    },
    limit(n) {
      limitCount = Number(n);
      return Promise.resolve({ data: materialize(), error: null });
    },
    then(resolve, reject) {
      return Promise.resolve({ data: materialize(), error: null }).then(resolve, reject);
    }
  };
  function materialize() {
    let out = rows.slice();
    for (const f of filters) {
      out = out.filter((row) => {
        if (!row) return false;
        if (f.op === "gte") return row[f.key] && String(row[f.key]) >= String(f.value);
        return row[f.key] === f.value;
      });
    }
    if (Number.isFinite(limitCount)) out = out.slice(0, limitCount);
    return out;
  }
  return chain;
}

function makeSupabase({ debts = [], intents = [], events = [] } = {}) {
  const insertedEvents = events.slice();
  return {
    events: insertedEvents,
    from(table) {
      if (table === "debts") {
        return {
          select() {
            return makeSelectChain(debts);
          }
        };
      }
      if (table === "payment_intents") {
        return {
          select() {
            return makeSelectChain(intents);
          }
        };
      }
      if (table === "notification_events") {
        return {
          select() {
            return makeSelectChain(insertedEvents);
          },
          insert(payload) {
            const row = {
              id: `event-${insertedEvents.length + 1}`,
              created_at: payload.created_at || "2030-05-19T12:00:00.000Z",
              ...payload
            };
            insertedEvents.push(row);
            return {
              select() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: { id: row.id }, error: null });
                  }
                };
              }
            };
          }
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }
  };
}

function withEnv(env, fn) {
  const keys = [
    "DEBTYA_ADMIN_ALERT_EMAILS",
    "DEBTYA_ADMIN_EMAILS",
    "DEBTYA_ADMIN_ALERT_AUDIT_USER_ID",
    "DEBTYA_ADMIN_USER_IDS",
    "DEBTYA_ADMIN_ALERT_COOLDOWN_HOURS"
  ];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (env[key] == null) delete process.env[key];
    else process.env[key] = env[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

describe("lib/admin-diagnostics-alerts", () => {
  it("resuelve destinatarios desde DEBTYA_ADMIN_ALERT_EMAILS o DEBTYA_ADMIN_EMAILS", () => {
    assert.deepEqual(
      resolveAdminAlertRecipients({
        DEBTYA_ADMIN_ALERT_EMAILS: "Owner@Example.com; owner@example.com ops@example.com",
        DEBTYA_ADMIN_EMAILS: "fallback@example.com"
      }),
      ["owner@example.com", "ops@example.com"]
    );
    assert.deepEqual(
      resolveAdminAlertRecipients({ DEBTYA_ADMIN_EMAILS: "admin@example.com invalid-value" }),
      ["admin@example.com"]
    );
  });

  it("envia alerta segura cuando diagnostics esta en warning", async () => {
    await withEnv(
      {
        DEBTYA_ADMIN_ALERT_EMAILS: "owner@example.com ops@example.com",
        DEBTYA_ADMIN_ALERT_AUDIT_USER_ID: auditUserId
      },
      async () => {
        const sends = [];
        const supabaseAdmin = makeSupabase({
          debts: [
            {
              id: "660e8400-e29b-41d4-a716-446655440000",
              user_id: "secret-user",
              status: "paid",
              balance: 25,
              is_active: true
            }
          ]
        });

        const out = await runAdminDiagnosticsAlert({
          supabaseAdmin,
          now: new Date("2030-05-19T12:00:00.000Z"),
          limit: 50,
          serverVersion: "test-v129",
          sendEmailFn: async (args) => {
            sends.push(args);
            return { sent: true, provider: "test" };
          }
        });

        assert.equal(out.ok, true);
        assert.equal(out.skipped, false);
        assert.equal(out.reason, "admin_alert_sent");
        assert.equal(out.recipients_count, 2);
        assert.equal(out.sent_count, 2);
        assert.equal(out.failed_count, 0);
        assert.equal(out.audit_recorded, true);
        assert.equal(supabaseAdmin.events.length, 1);
        assert.equal(supabaseAdmin.events[0].event_type, "test");
        assert.equal(supabaseAdmin.events[0].metadata.audit_type, ADMIN_DIAGNOSTICS_ALERT_AUDIT_TYPE);
        assert.ok(sends[0].preview.email_body.includes("paid_debts_with_positive_balance"));
        assert.ok(sends[0].preview.email_body.includes("test-v129"));
        assert.equal(JSON.stringify(out).includes("owner@example.com"), false);
        assert.equal(JSON.stringify(out).includes("ops@example.com"), false);
        assert.equal(sends[0].preview.email_body.includes("secret-user"), false);
      }
    );
  });

  it("no envia cuando diagnostics esta ok", async () => {
    await withEnv({ DEBTYA_ADMIN_EMAILS: "owner@example.com", DEBTYA_ADMIN_ALERT_AUDIT_USER_ID: auditUserId }, async () => {
      const sends = [];
      const supabaseAdmin = makeSupabase({
        debts: [{ id: "debt-1", status: "active", balance: 100, is_active: true }]
      });

      const out = await runAdminDiagnosticsAlert({
        supabaseAdmin,
        now: new Date("2030-05-19T12:00:00.000Z"),
        sendEmailFn: async (args) => {
          sends.push(args);
          return { sent: true };
        }
      });

      assert.equal(out.skipped, true);
      assert.equal(out.reason, "diagnostics_ok");
      assert.equal(out.sent_count, 0);
      assert.equal(sends.length, 0);
      assert.equal(supabaseAdmin.events.length, 0);
    });
  });

  it("no envia si no hay destinatarios admin configurados", async () => {
    await withEnv({}, async () => {
      const sends = [];
      const supabaseAdmin = makeSupabase({
        debts: [{ id: "debt-1", status: "paid", balance: 100, is_active: true }]
      });

      const out = await runAdminDiagnosticsAlert({
        supabaseAdmin,
        sendEmailFn: async (args) => {
          sends.push(args);
          return { sent: true };
        }
      });

      assert.equal(out.skipped, true);
      assert.equal(out.reason, "admin_alert_recipients_missing");
      assert.equal(out.recipients_count, 0);
      assert.equal(sends.length, 0);
    });
  });

  it("respeta cooldown por fingerprint y permite force", async () => {
    await withEnv(
      {
        DEBTYA_ADMIN_EMAILS: "owner@example.com",
        DEBTYA_ADMIN_ALERT_AUDIT_USER_ID: auditUserId,
        DEBTYA_ADMIN_ALERT_COOLDOWN_HOURS: "24"
      },
      async () => {
        const fingerprint = buildAlertFingerprint(["paid_debts_with_positive_balance"]);
        const supabaseAdmin = makeSupabase({
          debts: [{ id: "debt-1", status: "paid", balance: 100, is_active: true }],
          events: [
            {
              id: "event-existing",
              user_id: auditUserId,
              channel: "email",
              event_type: "test",
              created_at: "2030-05-19T11:00:00.000Z",
              metadata: {
                audit_type: ADMIN_DIAGNOSTICS_ALERT_AUDIT_TYPE,
                fingerprint,
                delivery_status: "sent"
              }
            }
          ]
        });

        const sends = [];
        const base = {
          supabaseAdmin,
          now: new Date("2030-05-19T12:00:00.000Z"),
          sendEmailFn: async (args) => {
            sends.push(args);
            return { sent: true };
          }
        };

        const blocked = await runAdminDiagnosticsAlert(base);
        assert.equal(blocked.skipped, true);
        assert.equal(blocked.reason, "admin_alert_cooldown_active");
        assert.equal(sends.length, 0);

        const forced = await runAdminDiagnosticsAlert({ ...base, force: true });
        assert.equal(forced.skipped, false);
        assert.equal(forced.sent_count, 1);
        assert.equal(sends.length, 1);
      }
    );
  });
});
