function registerBillingRoutes(app, deps) {
  const {
    requireUser,
    stripe,
    STRIPE_PRICE_ID_BETA_MONTHLY,
    STRIPE_PORTAL_CONFIG_ID,
    getLatestBillingSubscriptionForUser,
    ensureProfile,
    getOrCreateStripeCustomerForUser,
    getBaseUrl,
    stripeDebug,
    jsonError
  } = deps;

  app.get("/billing/subscription-status", requireUser, async (req, res) => {
    try {
      const row = await getLatestBillingSubscriptionForUser(req.user.id);

      if (!row) {
        return res.json({
          ok: true,
          data: {
            status: "inactive",
            active: false,
            current_period_end: null,
            stripe_customer_id: null,
            stripe_subscription_id: null,
            cancel_at_period_end: false
          }
        });
      }

      return res.json({
        ok: true,
        data: {
          status: row.status || "inactive",
          active: !!row.active,
          current_period_end: row.current_period_end || null,
          stripe_customer_id: row.stripe_customer_id || null,
          stripe_subscription_id: row.stripe_subscription_id || null,
          cancel_at_period_end: !!row.cancel_at_period_end
        }
      });
    } catch (error) {
      return jsonError(res, 500, "Error cargando suscripción", {
        details: error.message
      });
    }
  });

  app.post("/stripe/create-checkout-session", requireUser, async (req, res) => {
    try {
      if (!stripe) {
        return jsonError(res, 500, "Stripe no configurado");
      }

      if (!STRIPE_PRICE_ID_BETA_MONTHLY) {
        return jsonError(res, 500, "STRIPE_PRICE_ID_BETA_MONTHLY no configurado");
      }

      await ensureProfile(req.user.id);

      const customerId = await getOrCreateStripeCustomerForUser(req.user);
      const baseUrl = getBaseUrl(req);

      const successUrl =
        req.body?.success_url ||
        `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`;

      const cancelUrl = req.body?.cancel_url || `${baseUrl}/?checkout=cancel`;

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [
          {
            price: STRIPE_PRICE_ID_BETA_MONTHLY,
            quantity: 1
          }
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: req.user.id,
        allow_promotion_codes: true,
        metadata: {
          supabase_user_id: req.user.id,
          plan_code: "debtya_beta_monthly"
        },
        subscription_data: {
          metadata: {
            supabase_user_id: req.user.id,
            plan_code: "debtya_beta_monthly"
          }
        }
      });

      stripeDebug("[STRIPE_CHECKOUT] session creada", {
        userId: req.user.id,
        customerId,
        sessionId: session.id,
        checkoutUrl: !!session.url
      });

      return res.json({
        ok: true,
        session_id: session.id,
        url: session.url
      });
    } catch (error) {
      return jsonError(res, 500, "Error creando checkout Stripe", {
        details: error.message
      });
    }
  });

  app.post("/stripe/create-portal-session", requireUser, async (req, res) => {
    try {
      if (!stripe) {
        return jsonError(res, 500, "Stripe no configurado");
      }

      const row = await getLatestBillingSubscriptionForUser(req.user.id);
      if (!row?.stripe_customer_id) {
        return jsonError(res, 400, "Este usuario no tiene customer de Stripe todavía");
      }

      const baseUrl = getBaseUrl(req);
      const returnUrl = req.body?.return_url || `${baseUrl}/`;

      const payload = {
        customer: row.stripe_customer_id,
        return_url: returnUrl
      };

      if (STRIPE_PORTAL_CONFIG_ID) {
        payload.configuration = STRIPE_PORTAL_CONFIG_ID;
      }

      const session = await stripe.billingPortal.sessions.create(payload);

      return res.json({
        ok: true,
        url: session.url
      });
    } catch (error) {
      return jsonError(res, 500, "Error creando portal Stripe", {
        details: error.message
      });
    }
  });
}

module.exports = { registerBillingRoutes };
