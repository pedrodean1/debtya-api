/**
 * Stripe webhook must use raw body; register before express.json().
 * getDeps is evaluated per request so helpers can be defined later in server.js.
 */
function attachStripeWebhook(app, express, getDeps) {
  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const deps = getDeps();
      const {
        stripe,
        STRIPE_WEBHOOK_SECRET,
        stripeDebug,
        stripeError,
        stripeInfo,
        jsonError,
        resolveStripeUserId,
        upsertBillingSubscriptionFromStripe
      } = deps;

      try {
        stripeDebug("[STRIPE_WEBHOOK] hit", {
          hasStripe: !!stripe,
          hasWebhookSecret: !!STRIPE_WEBHOOK_SECRET,
          contentType: req.headers["content-type"] || null
        });

        if (!stripe) {
          stripeError("[STRIPE_WEBHOOK] Stripe no configurado");
          return jsonError(res, 500, "Stripe no configurado");
        }

        if (!STRIPE_WEBHOOK_SECRET) {
          stripeError("[STRIPE_WEBHOOK] STRIPE_WEBHOOK_SECRET no configurado");
          return jsonError(res, 500, "STRIPE_WEBHOOK_SECRET no configurado");
        }

        const signature = req.headers["stripe-signature"];
        if (!signature) {
          stripeError("[STRIPE_WEBHOOK] falta stripe-signature");
          return jsonError(res, 400, "Falta Stripe-Signature");
        }

        let event;
        try {
          event = stripe.webhooks.constructEvent(
            req.body,
            signature,
            STRIPE_WEBHOOK_SECRET
          );
        } catch (err) {
          stripeError("[STRIPE_WEBHOOK] firma inválida", err.message);
          return jsonError(res, 400, "Firma webhook inválida", {
            details: err.message
          });
        }

        const eventType = event.type;
        const obj = event.data?.object || null;

        stripeInfo("[stripe] webhook recibido:", eventType);

        if (eventType === "checkout.session.completed") {
          const session = obj;
          const subscriptionId =
            typeof session?.subscription === "string"
              ? session.subscription
              : session?.subscription?.id || null;

          stripeDebug("[STRIPE_WEBHOOK] checkout.session.completed", {
            sessionId: session?.id || null,
            client_reference_id: session?.client_reference_id || null,
            customerId:
              typeof session?.customer === "string"
                ? session.customer
                : session?.customer?.id || null,
            subscriptionId
          });

          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const customerId =
              typeof subscription?.customer === "string"
                ? subscription.customer
                : subscription?.customer?.id || null;

            const userId = await resolveStripeUserId({
              session,
              subscription,
              customerId,
              fallbackUserId: session?.client_reference_id || null
            });

            stripeDebug("[STRIPE_WEBHOOK] subscription recuperada desde checkout", {
              subscriptionId: subscription?.id || null,
              userId,
              stripeCustomerId: customerId,
              status: subscription?.status || null
            });

            const saved = await upsertBillingSubscriptionFromStripe(subscription, userId);

            if (!saved) {
              throw new Error(
                "No se pudo persistir billing_subscriptions para checkout.session.completed"
              );
            }

            stripeInfo("[stripe] checkout persistido", {
              saved: !!saved,
              stripeSubscriptionId: saved?.stripe_subscription_id || null
            });
          } else {
            stripeDebug("[STRIPE_WEBHOOK] checkout.session.completed sin subscriptionId");
          }
        }

        if (
          eventType === "customer.subscription.created" ||
          eventType === "customer.subscription.updated" ||
          eventType === "customer.subscription.deleted"
        ) {
          const subscription = obj;
          const customerId =
            typeof subscription?.customer === "string"
              ? subscription.customer
              : subscription?.customer?.id || null;

          const userId = await resolveStripeUserId({
            subscription,
            customerId,
            fallbackUserId: subscription?.metadata?.supabase_user_id || null
          });

          stripeDebug("[STRIPE_WEBHOOK] customer.subscription event", {
            type: eventType,
            subscriptionId: subscription?.id || null,
            userId,
            stripeCustomerId: customerId,
            status: subscription?.status || null
          });

          const saved = await upsertBillingSubscriptionFromStripe(subscription, userId);

          if (!saved) {
            throw new Error(`No se pudo persistir billing_subscriptions para ${eventType}`);
          }

          stripeInfo("[stripe] subscription persistida", {
            type: eventType,
            saved: !!saved,
            stripeSubscriptionId: saved?.stripe_subscription_id || null
          });
        }

        if (
          eventType === "invoice.paid" ||
          eventType === "invoice.payment_failed" ||
          eventType === "invoice.payment_succeeded"
        ) {
          const invoice = obj;
          const subscriptionId =
            typeof invoice?.subscription === "string"
              ? invoice.subscription
              : invoice?.subscription?.id || null;

          stripeDebug("[STRIPE_WEBHOOK] invoice event", {
            type: eventType,
            invoiceId: invoice?.id || null,
            invoiceStatus: invoice?.status || null,
            subscriptionId
          });

          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const customerId =
              typeof subscription?.customer === "string"
                ? subscription.customer
                : subscription?.customer?.id || null;

            const userId = await resolveStripeUserId({
              subscription,
              customerId,
              fallbackUserId: subscription?.metadata?.supabase_user_id || null
            });

            const saved = await upsertBillingSubscriptionFromStripe(subscription, userId, {
              last_invoice_id: invoice?.id || null,
              last_invoice_status: invoice?.status || null
            });

            if (!saved) {
              throw new Error(`No se pudo persistir billing_subscriptions para ${eventType}`);
            }

            stripeInfo("[stripe] invoice sincronizada", {
              type: eventType,
              saved: !!saved,
              stripeSubscriptionId: saved?.stripe_subscription_id || null
            });
          } else {
            stripeDebug("[STRIPE_WEBHOOK] invoice event sin subscriptionId");
          }
        }

        return res.json({ ok: true, received: true, type: eventType });
      } catch (error) {
        deps.stripeError("[STRIPE_WEBHOOK] error general", error.message);
        deps.stripeDebug("[STRIPE_WEBHOOK] error stack", error.stack);

        return deps.jsonError(res, 500, "Error procesando webhook Stripe", {
          details: error.message
        });
      }
    }
  );
}

module.exports = { attachStripeWebhook };
