    (function purgeBadDebtyaApiBaseStorage() {
      try {
        const w = typeof window !== "undefined" ? window : null;
        const h = w && w.location ? String(w.location.hostname || "").toLowerCase() : "";
        if (h !== "www.debtya.com" && h !== "debtya.com") return;
        const raw = localStorage.getItem("DEBTYA_API_BASE");
        if (!raw || !String(raw).trim()) return;
        const clean = String(raw).trim().replace(/\/+$/, "");
        let sh = "";
        try {
          sh = new URL(clean.startsWith("http") ? clean : `https://${clean}`).hostname.toLowerCase();
        } catch (_) {}
        if (sh === "www.debtya.com" || sh === "debtya.com") localStorage.removeItem("DEBTYA_API_BASE");
      } catch (_) {}
    })();

    const SUPABASE_URL = (() => {
      try {
        const m = document.querySelector('meta[name="debtya-supabase-url"]');
        const c = m && m.getAttribute("content");
        if (c && String(c).trim()) return String(c).trim();
      } catch (_) {}
      return "https://spybejltsgzfxlwzobkh.supabase.co";
    })();
    const SUPABASE_ANON_KEY = (() => {
      try {
        const m = document.querySelector('meta[name="debtya-supabase-anon"]');
        const c = m && m.getAttribute("content");
        if (c && String(c).trim()) return String(c).trim();
      } catch (_) {}
      return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNweWJlamx0c2d6Znhsd3pvYmtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMzg3MDAsImV4cCI6MjA4NzcxNDcwMH0.gNcD19qAbc4fO0HnE7fK3yFLBq2NWlcyBq8LnokbmOs";
    })();
    let API_BASE = (() => {
      const w = typeof window !== "undefined" ? window : null;
      const pageHost = w && w.location ? String(w.location.hostname || "").toLowerCase() : "";
      const isDebtyaMarketing = pageHost === "www.debtya.com" || pageHost === "debtya.com";

      let injected =
        w && typeof w.__DEBTYA_API_BASE__ === "string" ? String(w.__DEBTYA_API_BASE__).trim().replace(/\/+$/, "") : "";
      if (injected) {
        try {
          const ih = new URL(injected.startsWith("http") ? injected : `https://${injected}`).hostname.toLowerCase();
          if (isDebtyaMarketing && (ih === "www.debtya.com" || ih === "debtya.com")) injected = "";
        } catch (_) {}
      }
      if (injected) return injected;
      try {
        const m = document.querySelector('meta[name="debtya-api-origin"]');
        const mc = m && m.getAttribute("content");
        if (mc && String(mc).trim()) return String(mc).trim().replace(/\/+$/, "");
      } catch (_) {}
      try {
        const saved = localStorage.getItem("DEBTYA_API_BASE");
        if (saved && String(saved).trim()) {
          const clean = String(saved).trim().replace(/\/+$/, "");
          let savedHost = "";
          try {
            savedHost = new URL(clean.startsWith("http") ? clean : `https://${clean}`).hostname.toLowerCase();
          } catch (_) {
            savedHost = "";
          }
          const savedIsMarketingHost = savedHost === "www.debtya.com" || savedHost === "debtya.com";
          if (!(isDebtyaMarketing && savedIsMarketingHost)) return clean;
        }
      } catch (_) {}
      if (isDebtyaMarketing) return "https://debtya-api.onrender.com";
      if (w && w.location && w.location.origin) return w.location.origin;
      return "https://www.debtya.com";
    })();

    /** Si la app abre en www pero la API esta en Render u otro host, detecta /health (CORS ya permite www). */
    const DEBTYA_API_PROBE_ORIGINS = ["https://debtya-api.onrender.com", "https://api.debtya.com"];
    let debtyaApiBaseProbePromise = null;
    async function ensureDebtyaApiBaseProbed() {
      if (debtyaApiBaseProbePromise) return debtyaApiBaseProbePromise;
      debtyaApiBaseProbePromise = (async () => {
        try {
          const loc = typeof window !== "undefined" ? window.location : null;
          if (!loc || !loc.hostname) return;
          const h = String(loc.hostname).toLowerCase();
          if (h !== "www.debtya.com" && h !== "debtya.com") return;
          const origin = loc.origin.replace(/\/+$/, "");
          if (String(API_BASE || "").replace(/\/+$/, "") !== origin) return;
          const hits = await Promise.all(
            DEBTYA_API_PROBE_ORIGINS.map(async (cand) => {
              const root = String(cand).replace(/\/+$/, "");
              try {
                const ac = new AbortController();
                const tid = setTimeout(() => ac.abort(), 1800);
                const r = await fetch(`${root}/health`, {
                  method: "GET",
                  signal: ac.signal,
                  mode: "cors",
                  cache: "no-store"
                });
                clearTimeout(tid);
                return r.ok ? root : null;
              } catch (_) {
                return null;
              }
            })
          );
          const pick = hits.find(Boolean);
          if (pick) {
            try {
              localStorage.setItem("DEBTYA_API_BASE", pick);
            } catch (_) {}
            API_BASE = pick;
          }
        } catch (_) {}
      })();
      return debtyaApiBaseProbePromise;
    }

    function renderDebtyaRevBadge(apiServerVersion) {
      const el = document.getElementById("debtyaUiRevBadge");
      if (!el) return;
      const m = document.querySelector('meta[name="debtya-ui-rev"]');
      const ui = m && m.content ? String(m.content).trim() : "?";
      const api =
        apiServerVersion != null && String(apiServerVersion).trim() ? String(apiServerVersion).trim() : "?";
      el.textContent = "UI " + ui + " ? API " + api;
    }

    async function probeDebtyaDeployBadge() {
      try {
        await ensureDebtyaApiBaseProbed();
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), 8000);
        const r = await fetch(`${API_BASE}/health`, {
          method: "GET",
          cache: "no-store",
          signal: ac.signal,
          mode: "cors"
        });
        clearTimeout(tid);
        const j = r.ok ? await r.json().catch(() => ({})) : {};
        const hdr = r.headers.get("X-Debtya-Server-Version") || r.headers.get("x-debtya-server-version");
        renderDebtyaRevBadge(j.server_version || hdr || null);
      } catch (_) {
        renderDebtyaRevBadge(null);
      }
    }

    /** Quita grid .hero heredado y fuerza ancho si el HTML servido aun es antiguo o hay cach? raro */
    function patchOverviewPanelLayout() {
      try {
        const panel = document.getElementById("overviewPanel");
        if (!panel) return;
        panel.classList.remove("hero");
        panel.style.display = "block";
        panel.style.width = "100%";
        panel.style.maxWidth = "100%";
        panel.style.minWidth = "0";
        panel.style.boxSizing = "border-box";
        const hm = panel.querySelector(".hero-main");
        if (hm) {
          hm.style.width = "100%";
          hm.style.maxWidth = "100%";
          hm.style.boxSizing = "border-box";
        }
      } catch (_) {}
    }

    const REQUEST_TIMEOUT_MS = 15000;

    const I18N_STORAGE_KEY = "debtya_ui_lang";
    const LS_BANK_EXCHANGED = "debtya_bank_exchange_done";
    const LS_BANK_DISCONNECT_PENDING = "debtya_open_bank_disconnect";
    let uiLang = localStorage.getItem(I18N_STORAGE_KEY) || "en";
    if (uiLang !== "en" && uiLang !== "es") uiLang = "en";

    const M = {
      en: {
        btn_login: "Log in",
        btn_signup: "Create account",
        btn_start_now: "Get started",
        brand_tagline: "Pay down debt with more structure and less stress.",
        land_pill: "Built for real monthly use",
        land_hero_title: "Get out of debt with a clear plan\u2014no guessing",
        land_hero_copy:
          "DebtYa analyzes your debts and tells you exactly what to pay, when, and why.",
        land_btn_start_free: "Start free",
        land_conv_steps_title: "Three simple steps",
        land_conv_step1_t: "Connect your bank",
        land_conv_step2_t: "See your personalized plan",
        land_conv_step3_t: "Follow your suggested payments",
        land_benefits_title: "Why DebtYa",
        land_benefit1: "Save on interest",
        land_benefit2: "Reduce financial stress",
        land_benefit3: "Have a clear plan",
        land_footer_copy:
          "DebtYa helps you organize and pay down debt. For help: support@debtya.com",
        price_name: "DebtYa Beta",
        price_copy: "Everything you need to connect accounts, organize debts, automate useful rules, and turn your strategy into real payments.",
        price_freq: "per month",
        price_i1: "Secure bank connection",
        price_i2: "Account and transaction import",
        price_i3: "Debt creation and tracking",
        price_i4: "Automatic rules such as roundup or fixed amount",
        price_i5: "Avalanche vs snowball comparison",
        price_i6: "Prepare, approve, and run suggested payments",
        price_i7: "Payment history you can review anytime",
        price_i8: "Steady foundation for month-to-month use",
        price_have_account: "I already have an account",
        price_helper: 'If you are already signed in, "Get started" continues to secure checkout. Otherwise you will sign in or create an account first.',
        legal_banner_title: "Terms and policies",
        legal_banner_copy: "DebtYa Beta is $9.99 per month. Your subscription renews automatically until you cancel. You can cancel anytime from your account settings or by contacting support.",
        legal_link_terms: "Terms",
        legal_link_privacy: "Privacy",
        legal_link_cancel: "Cancellation",
        legal_link_refund: "Refunds",
        legal_link_support: "Support",
        faq_title: "Frequently asked questions",
        faq_sub: "Short answers about how DebtYa fits into your routine.",
        faq_q1: "What is DebtYa?",
        faq_a1:
          "DebtYa is a simple workspace to connect your bank through Plaid, optionally bring in debt or liability data through Method where that integration is enabled, list your debts, choose a payoff strategy, use light automation with rules, and move from suggested payments to what you actually ran. Subscription billing runs through Stripe.",
        faq_q2: "Do I need to connect my bank?",
        faq_a2:
          "Connecting your bank keeps balances and imports up to date and makes linking debts easier. The product is designed around connected accounts for accurate numbers.",
        faq_q3: "Why review APR and minimum payment?",
        faq_a3:
          "Imports can suggest APR and minimum payment, but your statement is the source of truth. Double-check before saving a debt so your plan matches reality.",
        faq_q4: "How does billing work?",
        faq_a4:
          'DebtYa Beta is billed monthly through Stripe. When you use "Get started" while signed in, you complete checkout securely and return to the app with your subscription status updated.',
        faq_q5: "Can I cancel anytime?",
        faq_a5:
          "Yes. You can manage billing through your customer portal when your plan is active, or reach out to support for help.",
        faq_q6: "Who can I contact for help?",
        faq_a6:
          "Email support@debtya.com. The in-app assistant can answer general how-to questions, but it does not replace your lender, advisor, or official documents.",
        help_modal_title: "Help & guide",
        help_close: "Close",
        help_tab_guide: "Guide",
        help_tab_ask: "Ask assistant",
        help_tab_faq: "FAQ",
        help_guide_intro: "A calm path through the basics. Open this panel any time.",
        help_g1_t: "1. Sign in",
        help_g1_p: "Create an account or log in so your bank, debts, and plan are saved.",
        help_g2_t: "2. Connect and import",
        help_g2_p: "Use Connect bank, then import the accounts you want DebtYa to use.",
        help_g3_t: "3. Debts and plan",
        help_g3_p: "Add each debt (review APR and minimums), then set your payment plan and strategy.",
        help_g4_t: "4. Rules and suggested payments",
        help_g4_p: "Apply rules when you are ready, review suggested payments, then approve and run them from Actions.",
        help_g5_t: "5. Need more?",
        help_g5_p: "Use the FAQ tab, this assistant for general guidance, or email support?we never replace your statement or professional advice.",
        help_jump_faq: "Scroll to FAQ on this page",
        guide_assistant_off:
          "The assistant is not available here yet. Use the FAQ tab or email support@debtya.com.",
        help_ask_disclaimer:
          "The assistant explains how DebtYa works. It is not financial or legal advice. For exact numbers, use your statement or your lender.",
        help_ask_placeholder: "Ask how something works in DebtYa?",
        help_ask_send: "Send",
        help_fab_aria: "Open help and guide",
        guide_assistant_empty: "Type a question first.",
        guide_assistant_error: "Could not reach the assistant. Try again or use the FAQ.",
        guide_assistant_rate: "Too many requests. Please wait a bit and try again.",
        lbl_email: "Email",
        lbl_password: "Password",
        lbl_password_confirm: "Confirm password",
        err_password_mismatch: "Passwords do not match.",
        err_signup_password_pair_required:
          "Enter and confirm your password in both fields.",
        err_password_policy:
          "Your password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.",
        lbl_signup_verification_code: "Verification code",
        err_signup_code_invalid: "The code must be 6 digits.",
        signup_check_email_code:
          "We sent a 6-digit code to your email. Enter it below and press Create account again to finish.",
        login_check_email_code:
          "We sent a 6-digit code to your email. Enter it below and press Log in again to finish.",
        login_email_changed_reenter:
          "The email changed after the code was sent. Press Log in again to request a new code.",
        signup_email_changed_reenter:
          "The email changed after the code was sent. Press Create account again to request a new code.",
        signup_sending_code: "Sending code?",
        login_sending_code: "Checking credentials and sending code?",
        ph_email: "you@email.com",
        ph_password: "Your password",
        ph_password_confirm: "Repeat password",
        btn_reset_pw: "Email me a password reset link",
        pw_recovery_title: "Choose a new password",
        pw_recovery_sub:
          "Enter and confirm your new password, then use a 6-digit code from your email to finish. You will land here after opening the reset link.",
        pw_recovery_lbl_new: "New password",
        pw_recovery_send_code: "Email me a 6-digit code",
        pw_recovery_save: "Save new password",
        pw_recovery_cancel: "Cancel and sign out",
        pw_recovery_code_sent: "Check your email for the 6-digit code.",
        pw_recovery_done: "Password updated. Loading your account?",
        auth_footer_hint: "Sign in to connect your bank, activate your plan, and use your own numbers.",
        app_welcome_default: "Home",
        badge_session: "Signed in",
        badge_sub_active: "Subscription active",
        badge_sub_until_end: "Active until period ends",
        btn_activate_plan: "Activate plan",
        btn_manage_plan: "Manage plan",
        btn_logout: "Log out",
        advanced_operate_toggle: "More ? rules & payments",
        advanced_plan_toggle: "More plan options",
        advanced_intents_toggle: "More list options",
        hero_title: "See your plan. Take the next step.",
        hero_copy: "Debt balances, bank data, and your next payoff move?in one place.",
        dashboard_next_step_title: "Your next step",
        dashboard_next_no_debts: "Add your debts to get started.",
        dashboard_next_no_plan: "Create your payment plan.",
        dashboard_next_no_intents: "Generate your suggested payments.",
        dashboard_next_pay_line: "Pay {amount} to {debt} today",
        dashboard_debt_fallback: "this debt",
        dashboard_next_interest_saved: "You save ~{amount} in interest this month",
        dashboard_next_interest_na: "Add APR on this debt for a sharper interest estimate.",
        dashboard_next_accel: "This speeds up your path out of debt.",
        next_step_bank: "Next: connect your bank and import accounts so DebtYa can use real balances.",
        next_step_bank_btn: "Go to Actions",
        next_step_debts: "Next: add your debts (balance, APR, and minimum payment).",
        next_step_debts_btn: "Go to Debts & plan",
        next_step_plan: "Next: save your payment plan (strategy, mode, and monthly budget).",
        next_step_plan_btn: "Open payment plan",
        next_step_rules: "Next: create one paydown rule when you are ready.",
        next_step_rules_btn: "Go to rules",
        next_step_prepare: "Next: prepare suggested payments from your plan (Actions ? More).",
        next_step_prepare_btn: "Open Actions",
        next_step_review: "Next: you have suggested payments waiting for approval or execution.",
        next_step_review_btn: "Review payments",
        next_step_done: "You are set up for now. After new imports, use Actions to apply rules or refresh payments.",
        next_step_done_btn: "Scroll to Actions",
        btn_connect_bank: "Connect bank",
        btn_disconnect_bank: "Disconnect bank",
        sync_bank_pick_title: "Which bank do you want to remove?",
        sync_bank_pick_sub: "Pick the bank connection. On the next step we will ask you to confirm.",
        sync_bank_pick_label: "Bank connection",
        sync_bank_pick_continue: "Continue",
        sync_bank_pick_none: "There are no connected banks to disconnect.",
        btn_import_accounts: "Import accounts",
        btn_import_tx: "Import transactions",
        btn_intents_build: "Build payments",
        intents_build_response_label: "Last build response (JSON)",
        stat_total_debt: "Total debt",
        stat_active_debts: "Active debts",
        stat_pending_intents: "Suggested payments waiting",
        stat_executed_intents: "Payments completed",
        plan_summary_title: "Plan summary",
        plan_summary_sub: "Strategy, mode, and monthly extra at a glance.",
        lbl_strategy: "Strategy",
        lbl_mode: "Mode",
        strategy_avalanche: "Avalanche",
        strategy_snowball: "Snowball",
        lbl_monthly_extra: "Monthly extra",
        lbl_how_it_works: "How it works",
        plan_how_hint: "Avalanche targets the highest interest rate first. Snowball targets the smallest balance first.",
        sub_title: "Subscription",
        sub_sub: "Plan status and renewal.",
        btn_refresh: "Refresh",
        lbl_status: "Status",
        lbl_active: "Active",
        lbl_next_period: "Next period",
        lbl_actions: "Actions",
        sub_portal_hint: "If your plan is active, you can open your account page to manage it.",
        operate_title: "Connect bank (Plaid)",
        operate_sub:
          "Step 1: connect your bank and import accounts/transactions.",
        operate_rail_main: "Start here",
        operate_rail_advanced: "Advanced",
        method_panel_eyebrow: "Liability data (Method)",
        btn_apply_rules: "Apply rules",
        btn_approve_visible: "Approve payments",
        btn_execute_visible: "Run payments",
        operate_note: "Most days: Connect ? Import. Rules and preparing payments live under More.",
        operate_legal_html: 'By connecting accounts, you authorize DebtYa to receive financial information needed for the service through trusted third-party providers (for example Plaid for bank data and Stripe for subscription billing). Please also review our <a href="/legal.html#privacidad" style="color:var(--primary);font-weight:700;">Terms and Privacy Policy</a>.',
        method_panel_title: "Legacy liabilities",
        method_panel_hint: "Method discovers liabilities. Plaid stays for the bank you pay from. Create a Method profile, run Connect, sync, then import each debt into DebtYa.",
        method_panel_disabled:
          "Method is not enabled on this API host. Add METHOD_API_KEY to the Node service on Render and redeploy; open /health and confirm method_configured is true.",
        method_lbl_first: "First name",
        method_lbl_last: "Last name",
        method_lbl_phone: "Phone (E.164)",
        method_lbl_email: "Email",
        method_lbl_dob: "Date of birth (optional, ISO)",
        method_entity_label: "Method entity",
        method_btn_create_entity: "Create Method profile",
        method_btn_connect: "Connect liabilities",
        method_btn_sync: "Sync liabilities",
        method_btn_reset: "Clear Method profile (DebtYa)",
        method_reset_blurb:
          "Removes the Method entity, synced liabilities and Connect history stored for your account in DebtYa. Debts previously imported from Method become manual debts.",
        method_reset_confirm:
          "Clear Method data stored in DebtYa for your account? You can create a new Method profile afterwards.",
        method_reset_ok: "Method data cleared. You can create a new profile.",
        method_capable_badge: "Payable via Method",
        method_info_badge: "Informational only",
        method_import_balance: "Balance",
        method_import_apr: "APR",
        method_import_min: "Minimum",
        method_btn_import: "Import to DebtYa",
        method_import_ok: "Debt imported.",
        method_action_ok: "Done.",
        method_err_entity: "Create a Method profile first.",
        method_err_pick_entity: "Select a Method entity.",
        method_entity_hint_none:
          "No Method profile saved in DebtYa yet. Fill the form and press Create Method profile, or fix the load error below.",
        method_entity_hint_count: "{{n}} Method profile saved. Pick it for Connect / Sync.",
        method_entity_hint_creating: "Creating Method profile?",
        method_entity_load_err_generic: "Could not load Method profiles from the server.",
        method_entity_pick_empty: "(no profile yet)",
        method_empty_sync: "No Method liabilities synced yet.",
        method_imported_badge: "Imported",
        debt_source_method: "Method",
        debt_source_spinwheel: "Spinwheel",
        debt_spinwheel_payable: "Payable with Spinwheel",
        debt_spinwheel_plan_only: "Planning only",
        intent_pill_spinwheel: "Spinwheel",
        intent_spinwheel_coming_soon: "Automatic payments coming soon.",
        spinwheel_diag_title: "Spinwheel payment summary",
        spinwheel_diag_sub: "Counts of Spinwheel-linked debts for your account. No payments are started from here.",
        spinwheel_diag_loading: "Loading summary...",
        spinwheel_diag_total: "Spinwheel debt rows",
        spinwheel_diag_payable: "Payable (bill pay supported)",
        spinwheel_diag_planning: "Planning only (not bill-payable)",
        spinwheel_diag_field: "Field or data issues",
        spinwheel_diag_not_sup: "Bill pay not supported",
        spinwheel_diag_blocked: "Others (not payable)",
        spinwheel_diag_payable_list: "Payable debts",
        spinwheel_diag_hint:
          "This block is off by default. Your team can enable it with a URL fragment or saved browser flag (see release notes).",
        sw_debts_connect_title: "Connect your debts",
        sw_debts_connect_sub: "DebtYa can look up your real debts to build your plan automatically.",
        sw_connect_phone_lbl: "Phone",
        sw_connect_phone_ph: "+1 555 123 4567",
        sw_connect_dob_lbl: "Date of birth",
        sw_connect_search_btn: "Find my debts",
        sw_connect_code_lbl: "Code from text message",
        sw_connect_verify_btn: "Verify code",
        sw_connect_success: "Debts connected successfully.",
        sw_connect_already_synced: "Your debts were already linked. We refreshed your information.",
        sw_connect_err_generic: "We could not complete that step. Check your details and try again.",
        sw_connect_err_phone: "Enter the phone number you use with your lenders.",
        sw_connect_err_phone_invalid: "Enter a phone number with country code (for example +1 for the United States).",
        sw_connect_err_dob: "Enter your date of birth.",
        sw_connect_err_code: "Enter the code from your text message.",
        sw_connect_err_verify: "That code did not work. Request a new code and try again.",
        sw_connect_err_unexpected_link: "The link step returned an unexpected status. Try again or contact support.",
        sw_connect_unavailable: "Debt lookup is not available right now. Please try again later.",
        sim_counts_active_label: "Active debts",
        sim_counts_line_placeholder: "Active debts: 0",
        debt_source_plaid: "Plaid",
        debt_method_payable: "Payable (Method)",
        debt_method_info_only: "Informational",
        debts_title: "Debts",
        debts_sub: "Step 2: review/add your debts and adjust key amounts.",
        lbl_name: "Name",
        ph_debt_name: "e.g. Chase Freedom",
        lbl_balance: "Balance",
        lbl_min_payment: "Minimum payment",
        lbl_due_day: "Payment day",
        lbl_type: "Type",
        debt_type_cc: "Credit card",
        debt_type_pl: "Personal loan",
        debt_type_loan: "Loan",
        debt_type_other: "Other",
        btn_save_debt: "Save debt",
        rules_title: "Rules",
        rules_sub: "Three ways to steer extra money toward your debts when you apply rules.",
        rules_intro_three_ways:
          "Pick one style per rule: a fixed add-on, a percent of each purchase, or rounding up spare change. Then use Apply rules under Actions after importing transactions.",
        rules_one_only_hint:
          "You can only keep one rule. Use Edit to change it, the switch above to pause it, or Delete to replace it.",
        lbl_rules_master_switch: "Rules on/off",
        btn_edit_rule: "Edit rule",
        btn_cancel_rule_edit: "Cancel edit",
        btn_save_rule_changes: "Save changes",
        rule_updated: "Rule updated.",
        rule_enabled_ok: "Rules turned on.",
        rule_disabled_ok: "Rules turned off.",
        lbl_rule_way: "Pay-down style",
        lbl_mode_rule: "Mode",
        rule_way_monthly_fixed: "1 ? Fixed extra when rules run",
        rule_way_purchase_percent: "2 ? Percent of each purchase",
        rule_way_spare_change: "3 ? Round up spare change",
        rule_mode_hint_fixed: "Adds the same dollar amount each time you apply rules, toward one debt.",
        rule_mode_hint_percent: "Takes a percent of each eligible purchase and sends it toward your target debt.",
        rule_mode_hint_roundup: "Sends the ?spare change? needed to reach the next step (for example the next dollar).",
        rule_mode_hint_default: "Choose how this rule builds paydown amounts from your spending.",
        rule_hint_monthly_fixed:
          "Same extra amount applied when you run Apply rules (for example after each import), toward the debt you choose below.",
        rule_hint_purchase_percent:
          "Example: 10% on a $10 purchase adds $1 toward your target debt. Your Supabase apply_rules_v2 logic must use this percent on eligible spending.",
        rule_hint_spare_change:
          "Example: spend $10.30 with a $1 step ? the spare change is $0.70 toward your debt (next whole dollar is $11). Use step 1 for classic ?round to next dollar.?",
        lbl_roundup_step: "Round up step ($)",
        rule_roundup_pct: "Percent of purchase",
        rule_fixed: "Fixed extra",
        rule_roundup_change: "Spare change round-up",
        lbl_percent: "Percent of purchase",
        lbl_fixed_amount: "Fixed amount",
        lbl_roundup_to: "Round up to",
        lbl_min_purchase: "Minimum purchase",
        lbl_target_debt: "Target debt",
        btn_save_rule: "Save rule",
        payplan_title: "Payment plan",
        payplan_sub: "Step 3: define strategy, mode, and monthly budget.",
        plan_manual: "Manual",
        plan_safe_auto: "Safe auto",
        plan_full_auto: "Full auto",
        hint_strategy_avalanche:
          "Puts extra payments toward the highest APR first. Usually saves the most interest overall.",
        hint_strategy_snowball:
          "Puts extra payments toward the smallest balance first. Can feel faster because accounts drop off sooner.",
        hint_mode_manual:
          "You review and run suggested payments yourself. DebtYa prepares amounts; you stay in control.",
        hint_mode_safe_auto:
          "DebtYa can prepare payments with extra guardrails. You still confirm important steps in the app.",
        hint_mode_full_auto:
          "DebtYa prepares payments with the most automation this product supports. You should still monitor your accounts.",
        lbl_plan_pay_from: "Pay from (account)",
        lbl_plan_pay_toward: "Pay toward (debt)",
        plan_pay_from_hint:
          "Choose the checking or savings account you pay from. It is stored on new suggested payments when you prepare them.",
        plan_pay_toward_hint:
          "Optional: highlight which debt you consider the main target. Suggested payments can still follow your strategy across multiple debts.",
        plan_pay_from_none: "Not set",
        plan_pay_toward_none: "All debts (strategy)",
        meta_pay_from: "Pay from",
        meta_pay_toward: "Pay toward",
        intent_pay_from_unknown: "Not set in plan yet",
        lbl_monthly_budget: "Monthly budget",
        hint_monthly_budget:
          "Roughly how much you plan to put toward debt payments each month in this plan (minimums plus your strategy). You can change it anytime.",
        hint_monthly_extra:
          "Extra dollars on top of minimums that go to your priority debt first. It works together with your monthly budget.",
        btn_save_plan: "Save plan",
        btn_compare: "Compare strategies",
        btn_refresh_plan: "Refresh plan",
        intents_title: "Suggested payments",
        intents_sub: "Step 4: build, review, approve, and run payments.",
        btn_reconcile: "Update recent payments",
        tag_approved: "Approved ? ready to run",
        tag_pending: "Draft or waiting ? needs your OK",
        tag_executed: "Done ? applied to your balances",
        history_title: "History",
        history_sub: "See payments and how your balances changed.",
        accounts_title: "Connected accounts",
        accounts_sub: "Synced from your bank: cash accounts and debts in separate groups.",
        sync_banks_title: "Synced banks",
        sync_banks_funding_title: "Banks you pay from",
        sync_banks_liabilities_title: "Banks with debts you pay down",
        bank_role_modal_title: "What is this bank for?",
        bank_role_modal_sub:
          "Choose where to list this connection. All accounts still import; this only groups the bank in your workspace.",
        bank_role_funding_btn: "Pay from here ? checking, savings",
        bank_role_liabilities_btn: "Debts here ? cards, loans",
        bank_role_both_btn: "Both ? funding and debts at this bank",
        bank_role_cancel: "Cancel",
        sync_bank_default: "Bank",
        sync_bank_disconnect_aria: "Remove bank",
        sync_bank_disconnect_confirm:
          "Remove this bank connection? Accounts, debt links, plan funding, and imported transactions from this bank will be cleared in DebtYa.",
        sync_bank_modal_title: "Are you sure?",
        sync_bank_modal_body:
          "You are about to remove {bank} from DebtYa. Imported accounts, debt links, pay-from settings, and transaction history for this bank will be cleared. You can connect the bank again later if you want.",
        sync_bank_modal_cancel: "Not now",
        sync_bank_modal_confirm: "Yes, remove bank",
        sync_bank_disconnected_ok: "Bank connection removed.",
        accounts_sec_cash: "Cash and checking",
        accounts_sec_debt: "Credit cards and loans",
        accounts_sec_other: "Other (investments and similar)",
        accounts_empty_section: "No accounts in this category.",
        kind_checking: "Checking",
        kind_savings: "Savings",
        kind_cd: "Certificate of deposit",
        kind_mma: "Money market",
        kind_cash_other: "Depository account",
        kind_credit_card: "Credit card",
        kind_credit_line: "Credit line",
        kind_mortgage: "Mortgage",
        kind_auto_loan: "Auto loan",
        kind_student_loan: "Student loan",
        kind_loc_loan: "Line of credit",
        kind_loan_other: "Loan",
        kind_investment: "Investment",
        kind_brokerage: "Brokerage",
        kind_other: "Other",
        acct_credit_limit: "Credit limit",
        footer_disclaimer_html: "<strong>DebtYa</strong> is a personal finance organization tool. It is not a bank, financial advisor, credit repair agency, or debt relief service.",
        integrations_notice_html:
          '<div><p class="integrations-kicker">Transparency</p><h2 class="integrations-title">Connections, data, and partners</h2><p class="integrations-lead">DebtYa works with established providers so you can link bank accounts for balances, funding, and related workflows, and bring in debt or liability details where those integrations exist.</p><ul class="integrations-list"><li><strong>Bank connections.</strong> Authorized account linking and financial data typically use Plaid. What you can connect depends on your institution, product, and Plaid coverage.</li><li><strong>Debts and liabilities.</strong> Some liability information may come through specialized providers such as Method. Not every creditor or account type is supported.</li><li><strong>Planning vs. execution.</strong> DebtYa can surface, organize, and help you plan payments. Certain executions, account consent flows, or funding steps may depend on provider or bank enablement, permissions, and availability.</li><li><strong>Billing.</strong> Subscription charges for DebtYa are processed through Stripe as shown at checkout.</li><li><strong>Realistic limits.</strong> Features vary by geography, institution, product, and third-party quotas. We do not promise universal compatibility with every bank or creditor.</li></ul><p class="integrations-foot">Data is shared with service providers only as needed to deliver the product. Read our <a href="/legal.html#privacidad" style="color:var(--primary);font-weight:700;">Privacy Policy</a> and <a href="/legal.html#terminos" style="color:var(--primary);font-weight:700;">Terms</a> for the full picture.</p></div>',
        loading: "Loading...",
        toast_click_to_close: "Click to close",
        yes: "Yes",
        no: "No",
        err_generic: "Something went wrong. Please try again.",
        err_stale_method_api:
          "The DebtYa API is not on the latest release (obsolete Method message). Redeploy debtya-api, hard refresh this page, then try again. If the badge bottom-right does not match your deploy, the static HTML is also stale.",
        err_fetch: "Could not reach the server.",
        err_network: "There is a connection problem.",
        err_timeout: "The operation took too long. Try again.",
        err_upstream_unavailable:
          "The DebtYa server did not respond (busy or restarting). Wait a few seconds and try again.",
        err_login_creds: "Incorrect email or password.",
        err_email_confirm: "Confirm your email before signing in.",
        err_session: "Your session expired. Please sign in again.",
        err_no_bank: "Connect your bank first.",
        err_no_auth: "You need to sign in first.",
        err_stripe_cfg: "Payments are not available right now.",
        err_plaid_cfg: "Bank connection is not available right now.",
        debt_select_placeholder: "Select a debt",
        empty_debts: "You have no saved debts yet.",
        empty_rules: "You have no saved rules yet.",
        empty_intents: "No suggested payments yet. Use Build payments above (or Actions ? More) after applying rules and importing transactions.",
        empty_trace: "No history available yet.",
        empty_accounts: "No imported accounts yet.",
        empty_compare: "No comparison available yet.",
        lbl_debt_from_account: "Create debt from imported account",
        debt_from_account_none: "Manual entry (no pre-fill)",
        debt_from_account_hint: "Choose a credit or loan account you already imported to pre-fill this form. APR and minimum payment are starter values?adjust them to match your statement.",
        debt_name_suggested_hint: "We simplified the bank label?you can rename it anytime.",
        debt_min_from_import_hint: "This minimum payment came from your imported account data. Please confirm it on your statement.",
        debt_apr_from_import_hint: "This APR came from your imported account data. Please confirm it on your statement.",
        debt_form_review_note: "Before you save, review APR and minimum payment. They may be suggested starting values?compare with your statement and edit if needed. Highlighted fields came from your import and are easy to change.",
        debt_suggest_personal_loan: "Personal loan",
        debt_suggest_loan: "Loan",
        debt_suggest_credit: "Credit card",
        lbl_link_plaid: "Linked bank account (optional)",
        debt_link_help: "After you connect your bank and import accounts, you can match one here.",
        debt_link_none: "None",
        lbl_linked_plaid_block: "Linked bank account",
        debt_link_badge_short: "Linked",
        debt_link_badge: "Linked to imported bank account",
        debt_link_account_label: "Account",
        debt_link_mask_label: "Mask",
        debt_balance_manual_label: "Balance in DebtYa (manual)",
        debt_balance_imported_label: "Current from bank import",
        debt_balance_mismatch_hint: "These two amounts are different. Plans and payments still use your manual DebtYa balance until you change it yourself.",
        debt_balance_match_hint: "Imported balance matches your manual balance (within one cent).",
        btn_sync_imported_balance: "Update to imported balance",
        debt_balance_synced_ok: "Debt balance updated to match the imported amount.",
        debt_link_orphan: "Saved link not found among imported accounts. Pick again or unlink.",
        debt_link_saved: "Link updated.",
        err_debt_link_invalid: "That account cannot be linked. Import it first or pick another.",
        err_plan_funding_missing: "Pay-from account not found among your imported accounts.",
        err_plan_funding_type: "Pay-from account must be a deposit account (for example checking or savings).",
        err_plan_debt_invalid: "Target debt is not valid.",
        err_plan_debt_missing: "Target debt was not found.",
        err_bank_not_found: "That bank connection was not found.",
        debt_label: "Debt",
        apr_label: "APR",
        min_label: "Minimum",
        day_label: "Day",
        type_label: "Type",
        updated_label: "Updated",
        rule_pct_label: "Percent",
        rule_fixed_lbl: "Fixed amount",
        rule_roundup_lbl: "Round up",
        rule_min_purchase_lbl: "Minimum purchase",
        rule_active: "Active",
        rule_inactive: "Inactive",
        btn_delete_rule: "Delete rule",
        pill_executed: "executed",
        pill_approved: "approved",
        pill_active: "active",
        pill_trialing: "trialing",
        pill_inactive: "inactive",
        pill_draft: "draft",
        pill_pending: "pending",
        pill_built: "suggested",
        pill_proposed: "proposed",
        pill_ready: "ready",
        pill_pending_review: "pending review",
        pill_past_due: "past due",
        pill_canceled: "canceled",
        pill_unpaid: "unpaid",
        intent_title: "Payment",
        meta_debt: "Debt",
        meta_total: "Total",
        meta_created: "Created",
        meta_approved: "Approved",
        meta_executed: "Executed",
        meta_amount: "Amount",
        btn_approve: "Approve",
        btn_execute: "Execute",
        balance_applied: "Balance applied",
        prev_balance: "Previous",
        new_balance: "New",
        applied_tag: "Applied",
        acct_type: "Type",
        acct_subtype: "Subtype",
        acct_default: "Account",
        available_lbl: "Available",
        months_lbl: "Months",
        interest_total_lbl: "Total interest",
        total_paid_lbl: "Total paid",
        plan_mode_manual: "Manual",
        plan_mode_safe: "Safe auto",
        plan_mode_full: "Full auto",
        bill_active: "Active",
        promo_comp_hint:
          "If you have a complimentary access code (for example friends & family), enter it here to unlock the app without checkout.",
        promo_comp_label: "Access code",
        promo_comp_apply: "Apply code",
        promo_comp_ok: "Access activated.",
        promo_comp_already: "This account already has complimentary access.",
        promo_comp_err: "Could not apply the code.",
        promo_comp_need: "Enter a code first.",
        promo_comp_server_off:
          "This server has no promo codes configured (set DEBTYA_COMP_PROMO_CODES or DEBTYA_COMP_PROMO_CODE on the host and redeploy).",
        bill_trialing: "Trialing",
        bill_inactive: "Inactive",
        bill_past_due: "Past due",
        bill_canceled: "Canceled",
        bill_unpaid: "Unpaid",
        bill_incomplete: "Incomplete",
        bill_incomplete_expired: "Incomplete (expired)",
        bill_paused: "Paused",
        welcome_hello: "Hello",
        proc: "Processing...",
        signing_in: "Signing in...",
        creating_acct: "Creating account...",
        fill_email_pw: "Please enter email and password.",
        pw_reset_sent: "Password reset email sent.",
        enter_email_first: "Enter your email above first.",
        session_ok: "Signed in.",
        acct_created_check: "Account created. Check your email if confirmation is required, then sign in.",
        acct_created_in: "Account created and signed in.",
        stripe_opening: "Opening secure checkout...",
        portal_opening: "Opening your account page...",
        plaid_opening: "Opening bank connection...",
        importing: "Importing...",
        applying: "Applying...",
        building: "Preparing...",
        approving: "Approving...",
        executing: "Executing...",
        reconciling: "Reconciling...",
        checkout_need_auth: "Sign in or create an account first to continue.",
        checkout_done_refresh: "Subscription completed. Refreshing your plan...",
        checkout_cancel: "Checkout was canceled.",
        checkout_done_signin: "Checkout completed. Sign in to see your subscription.",
        intent_ok: "Payment approved.",
        intent_exec_ok: "Payment completed.",
        debt_saved: "Debt saved successfully.",
        rule_saved: "Rule saved successfully.",
        rule_deleted: "Rule deleted successfully.",
        plan_saved: "Plan saved successfully.",
        compare_ok: "Comparison ready.",
        accounts_imp: "Accounts imported",
        tx_imp: "Transactions imported",
        rules_applied: "Rules applied. Created",
        intents_built: "Suggested payments updated.",
        approved_n: "Approved",
        executed_n: "Executed",
        reconcile_ok: "Recent payments updated",
        connecting_bank: "Connecting bank...",
        bank_ok: "Bank connected successfully.",
        sign_in_first: "Please sign in first.",
        plaid_script: "Bank link could not load on this page.",
        no_link_token: "Connection token was not returned by the server.",
        proc_loading: "Loading...",
        err_checkout_url: "Checkout link was not available. Try again.",
        err_portal_url: "Account page link was not available. Try again.",
        err_plaid_exit: "Bank connection closed with an error.",
        rule_delete_confirm: "Delete this rule? This action cannot be undone.",
        err_rule_one_only: "You can only save one rule. Delete your current rule first."
      },
      es: {
        btn_login: "Entrar",
        btn_signup: "Crear cuenta",
        btn_start_now: "Empieza ahora",
        brand_tagline: "Paga tus deudas con mas orden y menos estres.",
        land_pill: "Pensado para el dia a dia",
        land_hero_title: "Sal de deudas con un plan claro \u2014 sin adivinar",
        land_hero_copy:
          "DebtYa analiza tus deudas y te dice exactamente qu\u00e9 pagar, cu\u00e1ndo y por qu\u00e9.",
        land_btn_start_free: "Empezar gratis",
        land_conv_steps_title: "Tres pasos sencillos",
        land_conv_step1_t: "Conecta tu banco",
        land_conv_step2_t: "Ve tu plan personalizado",
        land_conv_step3_t: "Sigue tus pagos sugeridos",
        land_benefits_title: "Por qu\u00e9 DebtYa",
        land_benefit1: "Ahorra intereses",
        land_benefit2: "Reduce estr\u00e9s financiero",
        land_benefit3: "Ten un plan claro",
        land_footer_copy:
          "DebtYa te ayuda a organizar y pagar tus deudas. Ayuda: support@debtya.com",
        price_name: "DebtYa Beta",
        price_copy: "Todo lo necesario para conectar tus cuentas, organizar tus deudas, automatizar reglas utiles y convertir tu estrategia en pagos reales.",
        price_freq: "al mes",
        price_i1: "Conexion bancaria segura",
        price_i2: "Importacion de cuentas y transacciones",
        price_i3: "Creacion y seguimiento de deudas",
        price_i4: "Reglas automaticas como redondeo o monto fijo",
        price_i5: "Comparacion avalancha vs bola de nieve",
        price_i6: "Preparar, aprobar y ejecutar pagos sugeridos",
        price_i7: "Historial de pagos que puedes revisar cuando quieras",
        price_i8: "Base estable para usar mes a mes",
        price_have_account: "Ya tengo cuenta",
        price_helper: 'Si ya tienes sesion iniciada, "Empieza ahora" sigue a un pago seguro. Si no, primero entraras o crearas tu cuenta.',
        legal_banner_title: "Terminos y politicas",
        legal_banner_copy: "DebtYa Beta cuesta $9.99 al mes. La suscripcion se renueva automaticamente hasta que canceles. Puedes cancelar en cualquier momento desde la configuracion de tu cuenta o escribiendo a soporte.",
        legal_link_terms: "Terminos",
        legal_link_privacy: "Privacidad",
        legal_link_cancel: "Cancelacion",
        legal_link_refund: "Reembolsos",
        legal_link_support: "Soporte",
        faq_title: "Preguntas frecuentes",
        faq_sub: "Respuestas cortas sobre como encaja DebtYa en tu rutina.",
        faq_q1: "Que es DebtYa?",
        faq_a1:
          "DebtYa es un espacio sencillo para conectar tu banco con Plaid, incorporar deudas o pasivos con Method cuando esa integracion este disponible, listar deudas, elegir una estrategia de pago, usar reglas ligeras y pasar de pagos sugeridos a lo que realmente ejecutaste. La suscripcion se cobra con Stripe.",
        faq_q2: "Necesito conectar mi banco?",
        faq_a2:
          "Conectar el banco mantiene saldos e importaciones al dia y facilita vincular deudas. El producto esta pensado para trabajar con cuentas conectadas y numeros mas fieles.",
        faq_q3: "Por que revisar APR y pago minimo?",
        faq_a3:
          "La importacion puede sugerir APR y pago minimo, pero tu estado de cuenta manda. Revisa antes de guardar para que el plan refleje la realidad.",
        faq_q4: "Como funciona la facturacion?",
        faq_a4:
          'DebtYa Beta se cobra mes a mes con Stripe. Si usas "Empieza ahora" con sesion iniciada, completas el pago seguro y vuelves a la app con tu suscripcion actualizada.',
        faq_q5: "Puedo cancelar cuando quiera?",
        faq_a5:
          "Si. Con plan activo puedes administrar la facturacion desde el portal de cliente o escribir a soporte.",
        faq_q6: "A quien contacto si necesito ayuda?",
        faq_a6:
          "Escribe a support@debtya.com. El asistente puede orientarte en el uso general, pero no sustituye a tu banco, asesor o documentos oficiales.",
        help_modal_title: "Ayuda y guia",
        help_close: "Cerrar",
        help_tab_guide: "Guia",
        help_tab_ask: "Preguntar al asistente",
        help_tab_faq: "FAQ",
        help_guide_intro: "Un recorrido tranquilo por lo basico. Vuelve a abrir este panel cuando quieras.",
        help_g1_t: "1. Inicia sesion",
        help_g1_p: "Crea cuenta o entra para guardar banco, deudas y plan.",
        help_g2_t: "2. Conecta e importa",
        help_g2_p: "Usa Conectar banco y luego importa las cuentas que quieras usar en DebtYa.",
        help_g3_t: "3. Deudas y plan",
        help_g3_p: "Agrega cada deuda (revisa APR y minimos) y define tu plan y estrategia.",
        help_g4_t: "4. Reglas y pagos sugeridos",
        help_g4_p: "Aplica reglas cuando toque, revisa pagos sugeridos y luego aprueba y ejecuta desde Acciones.",
        help_g5_t: "5. Necesitas mas?",
        help_g5_p: "Usa la pestana FAQ, este asistente para dudas generales o correo a soporte: no reemplazamos tu estado de cuenta ni asesoria profesional.",
        help_jump_faq: "Ir a las FAQ en esta pagina",
        guide_assistant_off:
          "El asistente no esta disponible en este servidor todavia. Usa la pestana FAQ o escribe a support@debtya.com.",
        help_ask_disclaimer:
          "El asistente explica como funciona DebtYa. No es asesoria financiera ni legal. Para cifras exactas, usa tu estado de cuenta o tu prestamista.",
        help_ask_placeholder: "Pregunta como funciona algo en DebtYa?",
        help_ask_send: "Enviar",
        help_fab_aria: "Abrir ayuda y guia",
        guide_assistant_empty: "Escribe una pregunta primero.",
        guide_assistant_error: "No se pudo contactar al asistente. Reintenta o usa el FAQ.",
        guide_assistant_rate: "Demasiadas solicitudes. Espera un momento e intentalo de nuevo.",
        lbl_email: "Email",
        lbl_password: "Contrasena",
        lbl_password_confirm: "Confirmar contrase?a",
        err_password_mismatch: "Las contrase?as no coinciden.",
        err_signup_password_pair_required:
          "Escribe la contrase?a y conf?rmala en ambos campos.",
        err_password_policy:
          "La contrase?a debe tener al menos 8 caracteres e incluir una may?scula, una min?scula, un n?mero y un car?cter especial.",
        lbl_signup_verification_code: "C?digo de verificaci?n",
        err_signup_code_invalid: "El c?digo debe tener 6 d?gitos.",
        signup_check_email_code:
          "Te enviamos un c?digo de 6 d?gitos a tu correo. Escr?belo abajo y vuelve a pulsar Crear cuenta para terminar.",
        login_check_email_code:
          "Te enviamos un c?digo de 6 d?gitos a tu correo. Escr?belo abajo y vuelve a pulsar Entrar para terminar.",
        login_email_changed_reenter:
          "Cambiaste el correo despu?s de enviar el c?digo. Pulsa Entrar otra vez para pedir un c?digo nuevo.",
        signup_email_changed_reenter:
          "Cambiaste el correo despu?s de enviar el c?digo. Pulsa Crear cuenta otra vez para pedir un c?digo nuevo.",
        signup_sending_code: "Enviando c?digo?",
        login_sending_code: "Comprobando datos y enviando c?digo?",
        ph_email: "tu@email.com",
        ph_password: "Tu contrase?a",
        ph_password_confirm: "Repite la contrase?a",
        btn_reset_pw: "Enviar link para cambiar contrasena",
        pw_recovery_title: "Elige una contrasena nueva",
        pw_recovery_sub:
          "Escribe y confirma tu nueva contrasena; luego usa el codigo de 6 digitos que enviamos a tu correo. Llegaras aqui despues de abrir el enlace del correo.",
        pw_recovery_lbl_new: "Contrasena nueva",
        pw_recovery_send_code: "Enviar codigo de 6 digitos al correo",
        pw_recovery_save: "Guardar contrasena nueva",
        pw_recovery_cancel: "Cancelar y cerrar sesion",
        pw_recovery_code_sent: "Revisa tu correo para el codigo de 6 digitos.",
        pw_recovery_done: "Contrasena actualizada. Cargando tu cuenta?",
        auth_footer_hint: "Inicia sesion para conectar tu banco, activar tu plan y usar tus datos reales.",
        app_welcome_default: "Panel principal",
        badge_session: "Sesion activa",
        badge_sub_active: "Suscripcion activa",
        badge_sub_until_end: "Activa hasta fin de periodo",
        btn_activate_plan: "Activar plan",
        btn_manage_plan: "Administrar plan",
        btn_logout: "Salir",
        advanced_operate_toggle: "Mas ? reglas y pagos",
        advanced_plan_toggle: "Mas opciones del plan",
        advanced_intents_toggle: "Mas opciones de la lista",
        hero_title: "Ve tu plan. Da el siguiente paso.",
        hero_copy: "Deudas, banco y tu siguiente paso para bajarlas?en un solo lugar.",
        dashboard_next_step_title: "Tu pr\u00F3ximo paso",
        dashboard_next_no_debts: "Agrega tus deudas para empezar",
        dashboard_next_no_plan: "Crea tu plan de pago",
        dashboard_next_no_intents: "Genera tus pagos sugeridos",
        dashboard_next_pay_line: "Paga {amount} a {debt} hoy",
        dashboard_debt_fallback: "esta deuda",
        dashboard_next_interest_saved: "Ahorras ~{amount} en intereses este mes",
        dashboard_next_interest_na: "A\u00F1ade el APR en esta deuda para estimar mejor los intereses.",
        dashboard_next_accel: "Esto acelera tu salida de deuda.",
        next_step_bank: "Siguiente: conecta tu banco e importa cuentas para usar saldos reales.",
        next_step_bank_btn: "Ir a Acciones",
        next_step_debts: "Siguiente: agrega tus deudas (balance, APR y pago minimo).",
        next_step_debts_btn: "Ir a Deudas y plan",
        next_step_plan: "Siguiente: guarda tu plan de pago (estrategia, modo y presupuesto).",
        next_step_plan_btn: "Abrir plan de pago",
        next_step_rules: "Siguiente: crea una regla de abono cuando quieras.",
        next_step_rules_btn: "Ir a reglas",
        next_step_prepare: "Siguiente: prepara pagos sugeridos desde tu plan (Acciones ? Mas).",
        next_step_prepare_btn: "Abrir Acciones",
        next_step_review: "Siguiente: tienes pagos sugeridos pendientes de aprobacion o ejecucion.",
        next_step_review_btn: "Ver pagos sugeridos",
        next_step_done: "Por ahora vas al dia. Tras nuevas importaciones, usa Acciones para reglas o pagos.",
        next_step_done_btn: "Ir a Acciones",
        btn_connect_bank: "Conectar banco",
        btn_disconnect_bank: "Desconectar banco",
        sync_bank_pick_title: "?Que banco quieres quitar?",
        sync_bank_pick_sub: "Elige la conexion. En el siguiente paso te pediremos confirmacion.",
        sync_bank_pick_label: "Conexion bancaria",
        sync_bank_pick_continue: "Continuar",
        sync_bank_pick_none: "No hay bancos conectados para desconectar.",
        btn_import_accounts: "Importar cuentas",
        btn_import_tx: "Importar transacciones",
        btn_intents_build: "Construir pagos",
        intents_build_response_label: "Ultima respuesta del servidor (JSON)",
        stat_total_debt: "Deuda total",
        stat_active_debts: "Deudas activas",
        stat_pending_intents: "Pagos sugeridos en espera",
        stat_executed_intents: "Pagos realizados",
        plan_summary_title: "Resumen del plan",
        plan_summary_sub: "Estrategia, modo y extra mensual de un vistazo.",
        lbl_strategy: "Estrategia",
        lbl_mode: "Modo",
        strategy_avalanche: "Avalancha",
        strategy_snowball: "Bola de nieve",
        lbl_monthly_extra: "Extra mensual",
        lbl_how_it_works: "Como funciona",
        plan_how_hint: "Avalancha ataca primero la tasa mas alta. Bola de nieve ataca primero el saldo mas pequeno.",
        sub_title: "Suscripcion",
        sub_sub: "Estado del plan y renovacion.",
        btn_refresh: "Refrescar",
        lbl_status: "Estado",
        lbl_active: "Activo",
        lbl_next_period: "Proximo periodo",
        lbl_actions: "Acciones",
        sub_portal_hint: "Si tu plan esta activo, puedes abrir la pagina de tu cuenta para administrarlo.",
        operate_title: "Conectar banco (Plaid)",
        operate_sub:
          "Primer paso: conecta tu banco e importa cuentas/movimientos.",
        operate_rail_main: "Empieza aqui",
        operate_rail_advanced: "Avanzado",
        method_panel_eyebrow: "Datos de pasivos (Method)",
        btn_apply_rules: "Aplicar reglas",
        btn_approve_visible: "Aprobar pagos",
        btn_execute_visible: "Ejecutar pagos",
        operate_note: "Lo usual: Conectar ? Importar. Reglas y preparar pagos estan en Mas.",
        operate_legal_html: 'Al conectar cuentas, autorizas a DebtYa a recibir la informacion financiera necesaria a traves de proveedores de confianza (por ejemplo Plaid para el banco conectado y Stripe para la suscripcion). Revisa tambien nuestros <a href="/legal.html#privacidad" style="color:var(--primary);font-weight:700;">Terminos y Politica de privacidad</a>.',
        method_panel_title: "Pasivos heredados",
        method_panel_hint: "Method descubre liabilities (deudas). Plaid sigue siendo el banco del que pagas. Crea perfil Method, ejecuta Conectar, sincroniza e importa cada deuda a DebtYa.",
        method_panel_disabled:
          "Method no esta activo en esta API: falta METHOD_API_KEY en el servicio Node (Render) o la API desplegada no es la ultima version. Abre /health y comprueba method_configured: true.",
        method_lbl_first: "Nombre",
        method_lbl_last: "Apellido",
        method_lbl_phone: "Telefono (E.164)",
        method_lbl_email: "Correo",
        method_lbl_dob: "Fecha de nacimiento (opcional, ISO)",
        method_entity_label: "Entidad Method",
        method_btn_create_entity: "Crear perfil Method",
        method_btn_connect: "Conectar liabilities",
        method_btn_sync: "Sincronizar liabilities",
        method_btn_reset: "Limpiar perfil Method",
        method_reset_blurb:
          "Quita la entidad Method, las liabilities sincronizadas y el historial de Connect guardados en DebtYa para tu usuario. Las deudas que venian de Method pasan a manual (conservan nombre y montos).",
        method_reset_confirm:
          "?Borrar en DebtYa los datos Method de tu cuenta (entidad, sync, Connect)? Podras crear un perfil Method nuevo despues.",
        method_reset_ok: "Listo: datos Method borrados en DebtYa. Ya puedes crear un perfil nuevo.",
        method_capable_badge: "Pagable con Method",
        method_info_badge: "Solo informativa",
        method_import_balance: "Saldo",
        method_import_apr: "APR",
        method_import_min: "Pago minimo",
        method_btn_import: "Importar a DebtYa",
        method_import_ok: "Deuda importada.",
        method_action_ok: "Listo.",
        method_err_entity: "Primero crea un perfil Method.",
        method_err_pick_entity: "Elige una entidad Method.",
        method_entity_hint_none:
          "Aun no hay perfil Method guardado en DebtYa. Rellena el formulario y pulsa Crear perfil Method, o corrige el error de carga abajo.",
        method_entity_hint_count: "{{n}} perfil Method guardado. Eligelo para Conectar / Sincronizar.",
        method_entity_hint_creating: "Creando perfil Method?",
        method_entity_load_err_generic: "No se pudieron cargar los perfiles Method desde el servidor.",
        method_entity_pick_empty: "(sin perfil aun)",
        method_empty_sync: "Aun no hay liabilities Method sincronizadas.",
        method_imported_badge: "Ya importada",
        debt_source_method: "Method",
        debt_source_spinwheel: "Spinwheel",
        debt_spinwheel_payable: "Pagable con Spinwheel",
        debt_spinwheel_plan_only: "Solo planificaci\u00F3n",
        intent_pill_spinwheel: "Spinwheel",
        intent_spinwheel_coming_soon: "Pr\u00F3ximamente pagos autom\u00E1ticos",
        spinwheel_diag_title: "Estado de pagos Spinwheel",
        spinwheel_diag_sub:
          "Conteos de deudas vinculadas a Spinwheel en tu cuenta. Desde aqui no se inician pagos.",
        spinwheel_diag_loading: "Cargando resumen...",
        spinwheel_diag_total: "Filas de deuda Spinwheel",
        spinwheel_diag_payable: "Pagables (bill pay soportado)",
        spinwheel_diag_planning: "Solo plan (sin bill pay)",
        spinwheel_diag_field: "Problemas de datos o validaci\u00F3n",
        spinwheel_diag_not_sup: "Bill pay no soportado",
        spinwheel_diag_blocked: "Resto (no pagables)",
        spinwheel_diag_payable_list: "Deudas pagables",
        spinwheel_diag_hint:
          "Este bloque va apagado por defecto. Tu equipo puede activarlo con un fragmento de URL o una marca en el navegador (ver notas de version).",
        sw_debts_connect_title: "Conecta tus deudas",
        sw_debts_connect_sub: "DebtYa puede buscar tus deudas reales para crear tu plan autom\u00e1ticamente.",
        sw_connect_phone_lbl: "Telefono",
        sw_connect_phone_ph: "+1 555 123 4567",
        sw_connect_dob_lbl: "Fecha de nacimiento",
        sw_connect_search_btn: "Buscar mis deudas",
        sw_connect_code_lbl: "C\u00f3digo recibido por SMS",
        sw_connect_verify_btn: "Verificar c\u00f3digo",
        sw_connect_success: "Deudas conectadas correctamente.",
        sw_connect_already_synced: "Tus deudas ya estaban conectadas. Actualizamos tu informaci\u00f3n.",
        sw_connect_err_generic: "No pudimos completar ese paso. Revisa los datos e intentalo de nuevo.",
        sw_connect_err_phone: "Escribe el telefono que usas con tus acreedores.",
        sw_connect_err_phone_invalid: "Escribe el telefono con codigo de pais (por ejemplo +1 en Estados Unidos).",
        sw_connect_err_dob: "Escribe tu fecha de nacimiento.",
        sw_connect_err_code: "Escribe el codigo del SMS.",
        sw_connect_err_verify: "Ese codigo no funciono. Pide uno nuevo e intentalo.",
        sw_connect_err_unexpected_link: "El enlace devolvio un estado inesperado. Reintenta o contacta soporte.",
        sw_connect_unavailable: "La busqueda de deudas no esta disponible ahora. Intentalo mas tarde.",
        sim_counts_active_label: "Deudas activas",
        sim_counts_line_placeholder: "Deudas activas: 0",
        debt_source_plaid: "Plaid",
        debt_method_payable: "Pagable (Method)",
        debt_method_info_only: "Informativa",
        debts_title: "Deudas",
        debts_sub: "Segundo paso: revisa/agrega deudas y ajusta montos clave.",
        lbl_name: "Nombre",
        ph_debt_name: "Ej: Chase Freedom",
        lbl_balance: "Balance",
        lbl_min_payment: "Pago minimo",
        lbl_due_day: "Dia de pago",
        lbl_type: "Tipo",
        debt_type_cc: "Tarjeta de credito",
        debt_type_pl: "Prestamo personal",
        debt_type_loan: "Prestamo",
        debt_type_other: "Otro",
        btn_save_debt: "Guardar deuda",
        rules_title: "Reglas",
        rules_sub: "Tres formas de enviar dinero extra a tus deudas al aplicar reglas.",
        rules_intro_three_ways:
          "Elige un estilo por regla: monto fijo, porcentaje de cada compra o redondear vueltos. Luego usa Aplicar reglas en Acciones despues de importar movimientos.",
        rules_one_only_hint:
          "Solo puedes tener una regla. Usa Editar para cambiarla, el interruptor arriba para pausarla, o Borrar para reemplazarla.",
        lbl_rules_master_switch: "Reglas activas",
        btn_edit_rule: "Editar regla",
        btn_cancel_rule_edit: "Cancelar edicion",
        btn_save_rule_changes: "Guardar cambios",
        rule_updated: "Regla actualizada.",
        rule_enabled_ok: "Reglas activadas.",
        rule_disabled_ok: "Reglas desactivadas.",
        lbl_rule_way: "Forma de abonar",
        lbl_mode_rule: "Modo",
        rule_way_monthly_fixed: "1 ? Monto fijo al aplicar reglas",
        rule_way_purchase_percent: "2 ? Porcentaje de cada compra",
        rule_way_spare_change: "3 ? Redondear vueltos",
        rule_mode_hint_fixed: "Suma el mismo monto cada vez que aplicas reglas, hacia una deuda.",
        rule_mode_hint_percent: "Toma un porcentaje de cada compra elegible y lo envia a la deuda objetivo.",
        rule_mode_hint_roundup: "Envia el cambio que falta para llegar al siguiente paso (por ejemplo el siguiente dolar).",
        rule_mode_hint_default: "Elige como esta regla arma montos desde tus gastos.",
        rule_hint_monthly_fixed:
          "El mismo monto extra cuando ejecutas Aplicar reglas (por ejemplo tras cada importacion), hacia la deuda que elijas abajo.",
        rule_hint_purchase_percent:
          "Ejemplo: 10% sobre $10 de compra suma $1 hacia tu deuda. Tu apply_rules_v2 en Supabase debe usar este porcentaje sobre gastos elegibles.",
        rule_hint_spare_change:
          "Ejemplo: gastas $10.30 con paso $1 ? el vueltito es $0.70 hacia la deuda (el siguiente entero es $11). Paso 1 = redondear al siguiente dolar.",
        lbl_roundup_step: "Paso de redondeo ($)",
        rule_roundup_pct: "Porcentaje de la compra",
        rule_fixed: "Extra fijo",
        rule_roundup_change: "Redondeo de vueltos",
        lbl_percent: "Porcentaje de la compra",
        lbl_fixed_amount: "Monto fijo",
        lbl_roundup_to: "Redondear a",
        lbl_min_purchase: "Compra minima",
        lbl_target_debt: "Deuda objetivo",
        btn_save_rule: "Guardar regla",
        payplan_title: "Plan de pagos",
        payplan_sub: "Tercer paso: define estrategia, modo y presupuesto mensual.",
        plan_manual: "Manual",
        plan_safe_auto: "Automatico seguro",
        plan_full_auto: "Automatico total",
        hint_strategy_avalanche:
          "Destina los pagos extra a la tasa mas alta primero. Suele ahorrar mas intereses en total.",
        hint_strategy_snowball:
          "Destina los pagos extra al saldo mas pequeno primero. A veces se siente mas rapido porque cierras cuentas antes.",
        hint_mode_manual:
          "Tu revisas y ejecutas los pagos sugeridos. DebtYa prepara montos; tu mantienes el control.",
        hint_mode_safe_auto:
          "DebtYa puede preparar pagos con mas limites de seguridad. Sigues confirmando pasos importantes en la app.",
        hint_mode_full_auto:
          "DebtYa prepara pagos con la automatizacion mas alta que ofrece el producto. De todos modos conviene revisar tus cuentas.",
        lbl_plan_pay_from: "Pagar desde (cuenta)",
        lbl_plan_pay_toward: "Pagar hacia (deuda)",
        plan_pay_from_hint:
          "Elige la cuenta corriente o de ahorros desde la que pagas. Se guarda en los pagos sugeridos nuevos cuando los preparas.",
        plan_pay_toward_hint:
          "Opcional: indica que deuda consideras el foco principal. Los montos sugeridos pueden seguir repartiendose segun tu estrategia.",
        plan_pay_from_none: "Sin definir",
        plan_pay_toward_none: "Todas las deudas (estrategia)",
        meta_pay_from: "Pagar desde",
        meta_pay_toward: "Pagar hacia",
        intent_pay_from_unknown: "Sin cuenta en el plan aun",
        lbl_monthly_budget: "Presupuesto mensual",
        hint_monthly_budget:
          "Aproximadamente cuanto planeas destinar a pagos de deuda cada mes en este plan (minimos mas tu estrategia). Puedes cambiarlo cuando quieras.",
        hint_monthly_extra:
          "Dinero extra por encima de los minimos que va primero a tu deuda prioritaria. Se usa junto con el presupuesto mensual.",
        btn_save_plan: "Guardar plan",
        btn_compare: "Comparar estrategias",
        btn_refresh_plan: "Refrescar plan",
        intents_title: "Pagos sugeridos",
        intents_sub: "Cuarto paso: construir, revisar, aprobar y ejecutar pagos.",
        btn_reconcile: "Actualizar pagos recientes",
        tag_approved: "Aprobados ? listos para ejecutar",
        tag_pending: "Borrador o en espera ? falta tu visto bueno",
        tag_executed: "Listos ? ya aplicados a tus balances",
        history_title: "Historial",
        history_sub: "Pagos y como cambiaron tus balances.",
        accounts_title: "Cuentas conectadas",
        accounts_sub: "Sincronizadas con tu banco: efectivo y deudas en grupos separados.",
        sync_banks_title: "Bancos sincronizados",
        sync_banks_funding_title: "Bancos desde los que pagas",
        sync_banks_liabilities_title: "Bancos con deudas a las que va el dinero",
        bank_role_modal_title: "?Para que usas este banco?",
        bank_role_modal_sub:
          "Elige en que grupo mostrar esta conexion. Igual se importan todas las cuentas; solo organiza el banco en la app.",
        bank_role_funding_btn: "Sacar dinero de aqui ? cuenta corriente, ahorros",
        bank_role_liabilities_btn: "Deudas aqui ? tarjetas, prestamos",
        bank_role_both_btn: "Ambos ? origen y deudas en este banco",
        bank_role_cancel: "Cancelar",
        sync_bank_default: "Banco",
        sync_bank_disconnect_aria: "Quitar banco",
        sync_bank_disconnect_confirm:
          "?Quitar esta conexion bancaria? Se borraran en DebtYa las cuentas, enlaces con deudas, cuenta de origen del plan y movimientos importados de este banco.",
        sync_bank_modal_title: "?Seguro?",
        sync_bank_modal_body:
          "Vas a quitar {bank} de DebtYa. Se borraran las cuentas importadas, enlaces con deudas, la cuenta de origen del plan si aplica y el historial de movimientos de este banco. Luego puedes volver a conectar si quieres.",
        sync_bank_modal_cancel: "Mejor no",
        sync_bank_modal_confirm: "Si, quitar banco",
        sync_bank_disconnected_ok: "Conexion bancaria quitada.",
        accounts_sec_cash: "Efectivo y cuentas corrientes",
        accounts_sec_debt: "Tarjetas y prestamos",
        accounts_sec_other: "Otras (inversiones y similares)",
        accounts_empty_section: "No hay cuentas en esta categoria.",
        kind_checking: "Cuenta corriente",
        kind_savings: "Ahorros",
        kind_cd: "Deposito a plazo",
        kind_mma: "Mercado monetario",
        kind_cash_other: "Cuenta de deposito",
        kind_credit_card: "Tarjeta de credito",
        kind_credit_line: "Linea de credito",
        kind_mortgage: "Hipoteca",
        kind_auto_loan: "Prestamo de auto",
        kind_student_loan: "Prestamo estudiantil",
        kind_loc_loan: "Linea de credito (prestamo)",
        kind_loan_other: "Prestamo",
        kind_investment: "Inversion",
        kind_brokerage: "Brokerage",
        kind_other: "Otra",
        acct_credit_limit: "Limite de credito",
        footer_disclaimer_html: "<strong>DebtYa</strong> es una herramienta de organizacion financiera personal. No es un banco, asesor financiero, agencia de reparacion de credito ni servicio de alivio de deudas.",
        integrations_notice_html:
          '<div><p class="integrations-kicker">Transparencia</p><h2 class="integrations-title">Conexiones, datos y proveedores</h2><p class="integrations-lead">DebtYa colabora con proveedores reconocidos para que puedas vincular cuentas bancarias con fines de saldos, funding y flujos relacionados, y traer datos de deudas o pasivos cuando exista esa integracion.</p><ul class="integrations-list"><li><strong>Conexion bancaria.</strong> La vinculacion autorizada y los datos financieros suelen pasar por Plaid. Lo que puedas conectar depende de tu institucion, producto y cobertura de Plaid.</li><li><strong>Deudas y pasivos.</strong> Parte de la informacion puede llegar por proveedores especializados como Method. No todos los acreedores ni tipos de cuenta son compatibles.</li><li><strong>Planificacion frente a ejecucion.</strong> DebtYa puede mostrar, ordenar y ayudarte a planificar pagos. Ejecuciones concretas, consentimientos de cuenta o pasos de funding pueden depender de habilitaciones, permisos y disponibilidad del proveedor o del banco.</li><li><strong>Facturacion.</strong> Los cargos de suscripcion de DebtYa se procesan con Stripe segun lo que veas al pagar.</li><li><strong>Limites reales.</strong> Las funciones varian por region, institucion, producto y cupos de terceros. No prometemos compatibilidad universal con todo banco o acreedor.</li></ul><p class="integrations-foot">Compartimos datos con proveedores solo en la medida necesaria para prestar el servicio. Consulta la <a href="/legal.html#privacidad" style="color:var(--primary);font-weight:700;">Politica de privacidad</a> y los <a href="/legal.html#terminos" style="color:var(--primary);font-weight:700;">Terminos</a> para el detalle.</p></div>',
        loading: "Cargando...",
        yes: "Si",
        no: "No",
        err_generic: "Ocurrio un error. Intentalo de nuevo.",
        err_stale_method_api:
          "La API de DebtYa no esta en la ultima version (mensaje antiguo de Method). Vuelve a desplegar debtya-api, recarga esta pagina a fondo, e intentalo otra vez. Si la etiqueta abajo a la derecha no coincide con tu despliegue, el HTML estatico tambien esta desactualizado.",
        err_fetch: "No se pudo conectar con el servidor.",
        err_network: "Hay un problema de conexion.",
        err_timeout: "La operacion tardo demasiado. Intentalo otra vez.",
        err_upstream_unavailable:
          "El servidor de DebtYa no respondio (puede estar ocupado o reiniciando). Espera unos segundos y vuelve a intentarlo.",
        err_login_creds: "Email o contrasena incorrectos.",
        err_email_confirm: "Confirma tu email antes de entrar.",
        err_session: "Tu sesion expiro. Entra de nuevo.",
        err_no_bank: "Primero conecta tu banco.",
        err_no_auth: "Necesitas iniciar sesion primero.",
        err_stripe_cfg: "El sistema de pagos no esta listo ahora mismo.",
        err_plaid_cfg: "La conexion bancaria no esta disponible ahora mismo.",
        debt_select_placeholder: "Selecciona deuda",
        empty_debts: "Todavia no tienes deudas guardadas.",
        empty_rules: "Todavia no tienes reglas guardadas.",
        empty_intents: "Aun no hay pagos sugeridos. Pulsa Construir pagos arriba (o Acciones ? Mas) despues de aplicar reglas e importar movimientos.",
        empty_trace: "Todavia no hay historial disponible.",
        empty_accounts: "Todavia no hay cuentas importadas.",
        empty_compare: "Todavia no hay comparacion disponible.",
        lbl_debt_from_account: "Crear deuda desde cuenta importada",
        debt_from_account_none: "Entrada manual (sin autollenado)",
        debt_from_account_hint: "Elige una cuenta de credito o prestamo que ya importaste para autollenar el formulario. El APR y el pago minimo son valores iniciales: ajustalos a tu estado de cuenta.",
        debt_name_suggested_hint: "Simplificamos el nombre del banco; puedes cambiarlo cuando quieras.",
        debt_min_from_import_hint: "Este pago minimo viene de los datos importados de la cuenta. Confirmalo en tu estado de cuenta.",
        debt_apr_from_import_hint: "Este APR viene de los datos importados de la cuenta. Confirmalo en tu estado de cuenta.",
        debt_form_review_note: "Antes de guardar, revisa el APR y el pago minimo. Pueden ser valores sugeridos al inicio?comparalos con tu estado de cuenta y editalos si hace falta. Los campos resaltados vinieron del importe y puedes cambiarlos.",
        debt_suggest_personal_loan: "Prestamo personal",
        debt_suggest_loan: "Prestamo",
        debt_suggest_credit: "Tarjeta de credito",
        lbl_link_plaid: "Cuenta bancaria vinculada (opcional)",
        debt_link_help: "Despues de conectar tu banco e importar cuentas, puedes elegir la que corresponda.",
        debt_link_none: "Ninguna",
        lbl_linked_plaid_block: "Cuenta bancaria vinculada",
        debt_link_badge_short: "Vinculada",
        debt_link_badge: "Vinculada a cuenta importada del banco",
        debt_link_account_label: "Cuenta",
        debt_link_mask_label: "Ultimos digitos",
        debt_balance_manual_label: "Balance en DebtYa (manual)",
        debt_balance_imported_label: "Actual desde importacion",
        debt_balance_mismatch_hint: "Los dos montos no coinciden. El plan y los pagos siguen usando el balance manual en DebtYa hasta que tu lo cambies.",
        debt_balance_match_hint: "El saldo importado coincide con tu balance manual (margen de un centavo).",
        btn_sync_imported_balance: "Actualizar al saldo importado",
        debt_balance_synced_ok: "Balance de la deuda actualizado al monto importado.",
        debt_link_orphan: "El vinculo guardado no aparece entre las cuentas importadas. Elige de nuevo o desvincula.",
        debt_link_saved: "Vinculo actualizado.",
        err_debt_link_invalid: "No se puede vincular esa cuenta. Importala primero u otra.",
        err_plan_funding_missing: "La cuenta de origen no aparece entre tus cuentas importadas.",
        err_plan_funding_type: "La cuenta de origen debe ser de deposito (por ejemplo cheques o ahorros).",
        err_plan_debt_invalid: "La deuda destino no es valida.",
        err_plan_debt_missing: "No se encontro la deuda destino.",
        err_bank_not_found: "No encontramos esa conexion bancaria.",
        debt_label: "Deuda",
        apr_label: "APR",
        min_label: "Minimo",
        day_label: "Dia",
        type_label: "Tipo",
        updated_label: "Actualizado",
        rule_pct_label: "Porcentaje",
        rule_fixed_lbl: "Monto fijo",
        rule_roundup_lbl: "Redondeo",
        rule_min_purchase_lbl: "Compra minima",
        rule_active: "Activa",
        rule_inactive: "Inactiva",
        btn_delete_rule: "Borrar regla",
        pill_executed: "ejecutado",
        pill_approved: "aprobado",
        pill_active: "activa",
        pill_trialing: "en prueba",
        pill_inactive: "inactiva",
        pill_draft: "borrador",
        pill_pending: "pendiente",
        pill_built: "sugerido",
        pill_proposed: "propuesto",
        pill_ready: "listo",
        pill_pending_review: "pendiente de revision",
        pill_past_due: "vencido",
        pill_canceled: "cancelado",
        pill_unpaid: "no pagado",
        intent_title: "Pago",
        meta_debt: "Deuda",
        meta_total: "Total",
        meta_created: "Creado",
        meta_approved: "Aprobado",
        meta_executed: "Ejecutado",
        meta_amount: "Monto",
        btn_approve: "Aprobar",
        btn_execute: "Ejecutar",
        balance_applied: "Balance aplicado",
        prev_balance: "Previo",
        new_balance: "Nuevo",
        applied_tag: "Aplicado",
        acct_type: "Tipo",
        acct_subtype: "Subtipo",
        acct_default: "Cuenta",
        available_lbl: "Disponible",
        months_lbl: "Meses",
        interest_total_lbl: "Interes total",
        total_paid_lbl: "Total pagado",
        plan_mode_manual: "Manual",
        plan_mode_safe: "Automatico seguro",
        plan_mode_full: "Automatico total",
        bill_active: "Activa",
        promo_comp_hint:
          "Si te compartieron un c?digo de invitaci?n (amigos o familia), escr?belo en el campo de abajo y pulsa ?Aplicar c?digo? para usar la app sin pasar por el pago.",
        promo_comp_label: "C?digo de invitaci?n",
        promo_comp_apply: "Aplicar c?digo",
        promo_comp_ok: "Acceso activado.",
        promo_comp_already: "Esta cuenta ya tiene acceso complementario.",
        promo_comp_err: "No se pudo aplicar el codigo.",
        promo_comp_need: "Escribe un c?digo primero.",
        promo_comp_server_off:
          "Este servidor no tiene codigos de promocion configurados (define DEBTYA_COMP_PROMO_CODES o DEBTYA_COMP_PROMO_CODE en el host y redeploy).",
        bill_trialing: "En prueba",
        bill_inactive: "Inactiva",
        bill_past_due: "Pago vencido",
        bill_canceled: "Cancelada",
        bill_unpaid: "No pagada",
        bill_incomplete: "Incompleta",
        bill_incomplete_expired: "Incompleta vencida",
        bill_paused: "Pausada",
        welcome_hello: "Hola",
        proc: "Procesando...",
        toast_click_to_close: "Clic para cerrar",
        signing_in: "Entrando...",
        creating_acct: "Creando...",
        fill_email_pw: "Completa email y contrasena.",
        pw_reset_sent: "Se envio el link para cambiar contrasena.",
        enter_email_first: "Pon tu email arriba primero.",
        session_ok: "Sesion iniciada.",
        acct_created_check: "Cuenta creada. Revisa tu email si pide confirmacion y luego entra.",
        acct_created_in: "Cuenta creada e iniciada.",
        stripe_opening: "Abriendo pago seguro...",
        portal_opening: "Abriendo tu cuenta...",
        plaid_opening: "Abriendo conexion bancaria...",
        importing: "Importando...",
        applying: "Aplicando...",
        building: "Preparando...",
        approving: "Aprobando...",
        executing: "Ejecutando...",
        reconciling: "Actualizando...",
        checkout_need_auth: "Primero entra o crea tu cuenta para continuar.",
        checkout_done_refresh: "Suscripcion completada. Actualizando tu plan...",
        checkout_cancel: "El pago fue cancelado.",
        checkout_done_signin: "Pago completado. Entra a tu cuenta para ver tu suscripcion.",
        intent_ok: "Pago aprobado.",
        intent_exec_ok: "Pago completado.",
        debt_saved: "Deuda guardada correctamente.",
        rule_saved: "Regla guardada correctamente.",
        rule_deleted: "Regla borrada correctamente.",
        plan_saved: "Plan guardado correctamente.",
        compare_ok: "Comparacion lista.",
        accounts_imp: "Cuentas importadas",
        tx_imp: "Transacciones importadas",
        rules_applied: "Reglas aplicadas. Creados",
        intents_built: "Pagos sugeridos actualizados.",
        approved_n: "Aprobados",
        executed_n: "Ejecutados",
        reconcile_ok: "Pagos recientes actualizados",
        connecting_bank: "Conectando banco...",
        bank_ok: "Banco conectado correctamente.",
        sign_in_first: "Primero inicia sesion.",
        plaid_script: "No se pudo cargar el enlace bancario en esta pagina.",
        no_link_token: "No llego el token de conexion del servidor.",
        proc_loading: "Cargando...",
        err_checkout_url: "El enlace de pago no estuvo disponible. Intentalo de nuevo.",
        err_portal_url: "El enlace de tu cuenta no estuvo disponible. Intentalo de nuevo.",
        err_plaid_exit: "La conexion bancaria se cerro con error.",
        rule_delete_confirm: "Quieres borrar esta regla? Esta accion no se puede deshacer.",
        err_rule_one_only: "Solo puedes guardar una regla. Primero borra la regla actual."
      }
    };

    function t(key) {
      const pack = M[uiLang] || M.en;
      if (pack[key] !== undefined) return pack[key];
      return M.en[key] !== undefined ? M.en[key] : key;
    }

    function tf(key, vars = {}) {
      let s = t(key);
      Object.keys(vars).forEach((k) => {
        s = s.split(`{${k}}`).join(String(vars[k] ?? ""));
      });
      return s;
    }

    function syncLangButtons() {
      document.querySelectorAll(".lang-switch button[data-lang-btn]").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-lang-btn") === uiLang);
      });
    }

    function applyDomI18n() {
      document.documentElement.lang = uiLang;
      document.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        if (key) el.textContent = t(key);
      });
      document.querySelectorAll("[data-i18n-html]").forEach((el) => {
        const key = el.getAttribute("data-i18n-html");
        if (key) el.innerHTML = t(key);
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        const key = el.getAttribute("data-i18n-placeholder");
        if (key) el.setAttribute("placeholder", t(key));
      });
      document.querySelectorAll("option[data-i18n-opt]").forEach((opt) => {
        const key = opt.getAttribute("data-i18n-opt");
        if (key) opt.textContent = t(key);
      });
      document.querySelectorAll("[data-i18n-title]").forEach((el) => {
        const key = el.getAttribute("data-i18n-title");
        if (key) {
          const txt = t(key);
          el.setAttribute("title", txt);
          el.setAttribute("aria-label", txt);
        }
      });
      const helpFabEl = $("helpFab");
      if (helpFabEl) helpFabEl.setAttribute("aria-label", t("help_fab_aria"));
    }

    function setUiLang(next) {
      uiLang = next === "es" ? "es" : "en";
      localStorage.setItem(I18N_STORAGE_KEY, uiLang);
      syncLangButtons();
      applyDomI18n();
      document.querySelectorAll("button").forEach((b) => delete b.dataset.originalText);
      updateAuthModeUI();
      renderUser();
      if (!appView.classList.contains("hidden")) {
        renderBilling();
        renderDebts();
        renderRules();
        renderIntents();
        renderTrace();
        renderAccounts();
        renderPlan();
        syncRuleModeFields();
        updateRuleModeHint();
        if (state.lastCompare) renderCompare(state.lastCompare);
        updateNextActionGuide();
        const bdRoot = $("bankDisconnectModal");
        if (
          bdRoot &&
          !bdRoot.classList.contains("hidden") &&
          bankDcPendingId &&
          $("bankDcTitle") &&
          $("bankDcBody")
        ) {
          $("bankDcTitle").textContent = t("sync_bank_modal_title");
          $("bankDcBody").textContent = tf("sync_bank_modal_body", {
            bank: bankDcPendingName || t("sync_bank_default")
          });
          $("bankDcCancel").textContent = t("sync_bank_modal_cancel");
          $("bankDcConfirm").textContent = t("sync_bank_modal_confirm");
        }
        const dfab = $("debtyaDisconnectFab");
        if (dfab) {
          dfab.textContent = t("btn_disconnect_bank");
          dfab.setAttribute("aria-label", t("btn_disconnect_bank"));
        }
        void refreshSpinwheelPayableDiag();
      } else {
        $("sessionBadge").className = "pill blue";
        $("sessionBadge").textContent = t("badge_session");
      }
    }

    function wireLangButtons() {
      document.querySelectorAll(".lang-switch button[data-lang-btn]").forEach((b) => {
        b.addEventListener("click", () => setUiLang(b.getAttribute("data-lang-btn")));
      });
    }

    const PW_RECOVERY_PENDING_KEY = "debtya_pw_recovery_pending";
    const PW_RECOVERY_PENDING_TTL_MS = 30 * 60 * 1000;

    function decodeAccessTokenPayload(session) {
      try {
        const t = session?.access_token;
        if (!t || typeof t !== "string") return null;
        const parts = t.split(".");
        if (parts.length < 2) return null;
        const b = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
        return JSON.parse(atob(b + pad));
      } catch (_) {
        return null;
      }
    }

    /** PKCE recovery a veces no deja #type=recovery; GoTrue marca amr con method recovery. */
    function sessionLooksLikePasswordRecovery(session) {
      if (!session?.access_token) return false;
      const pl = decodeAccessTokenPayload(session);
      const amr = pl?.amr;
      if (!Array.isArray(amr)) return false;
      return amr.some((e) => e && String(e.method || "").toLowerCase() === "recovery");
    }

    function setPwRecoveryPending() {
      try {
        sessionStorage.setItem(PW_RECOVERY_PENDING_KEY, JSON.stringify({ at: Date.now() }));
      } catch (_) {}
    }
    function clearPwRecoveryPending() {
      try {
        sessionStorage.removeItem(PW_RECOVERY_PENDING_KEY);
      } catch (_) {}
    }
    function isPwRecoveryPending() {
      try {
        const raw = sessionStorage.getItem(PW_RECOVERY_PENDING_KEY);
        if (!raw) return false;
        const j = JSON.parse(raw);
        return j && typeof j.at === "number" && Date.now() - j.at < PW_RECOVERY_PENDING_TTL_MS;
      } catch (_) {
        return false;
      }
    }
    /** Antes de createClient: leer hash/query y quitar JWT viejo para que el recovery no pierda contra sesi?n guardada. */
    (function capturePwRecoveryFromUrlEarly() {
      try {
        const h = (window.location.hash || "").replace(/^#/, "");
        const q = new URLSearchParams(window.location.search || "");
        let mark = false;
        let hashSaysRecovery = false;
        if (h) {
          const p = new URLSearchParams(h);
          hashSaysRecovery =
            p.get("type") === "recovery" || /(^|[&])type=recovery(&|$)/.test(h) || h.includes("type%3Drecovery");
          if (hashSaysRecovery) mark = true;
        }
        if (q.get("type") === "recovery") mark = true;
        if (q.get("debtya_pw_recovery") === "1") mark = true;
        if (mark) {
          setPwRecoveryPending();
          if (hashSaysRecovery) {
            try {
              localStorage.removeItem("debtya_access_token");
              for (const k of Object.keys(localStorage)) {
                if (k.startsWith("sb-") && k.includes("auth-token")) localStorage.removeItem(k);
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    })();

    const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { detectSessionInUrl: true, storage: window.localStorage, persistSession: true, autoRefreshToken: true }
    });

    const state = {
      mode: "login",
      signupVerificationPending: false,
      signupVerificationEmail: null,
      loginVerificationPending: false,
      loginVerificationEmail: null,
      session: null,
      user: null,
      debts: [],
      rules: [],
      plan: null,
      intents: [],
      paymentIntents: [],
      trace: [],
      accounts: [],
      plaidItems: [],
      billing: null,
      lastCompare: null,
      editingRuleId: null,
      methodConfigured: false,
      methodEntities: [],
      methodAccounts: [],
      methodEntitiesLoadError: null,
      methodEntityCreating: false
    };

    const $ = (id) => document.getElementById(id);

    const landingView = $("landingView");
    const authView = $("authView");
    const appView = $("appView");
    const authForm = $("authForm");
    const authEmail = $("authEmail");
    const authPassword = $("authPassword");
    const authSubmitBtn = $("authSubmitBtn");
    const authMessage = $("authMessage");
    const globalMessage = $("globalMessage");

    wireAuthPasswordMaskBehavior(authPassword, $("authPasswordConfirm"));
    wireAuthPasswordMaskBehavior($("pwRecoveryNew"), $("pwRecoveryConfirm"));

    function showPasswordRecoveryPanel() {
      const panel = $("passwordRecoveryPanel");
      const block = $("authNormalBlock");
      if (block) block.classList.add("hidden");
      if (panel) panel.classList.remove("hidden");
      landingView.classList.add("hidden");
      authView.classList.remove("hidden");
      appView.classList.add("hidden");
      const line = $("pwRecoveryEmailLine");
      if (line) line.textContent = state.user?.email || "";
      try {
        const path = window.location.pathname || "/";
        const search = window.location.search || "";
        window.history.replaceState({}, document.title, `${path}${search}`);
      } catch (_) {}
      applyDomI18n();
    }

    function hidePasswordRecoveryPanel() {
      const panel = $("passwordRecoveryPanel");
      const block = $("authNormalBlock");
      if (panel) panel.classList.add("hidden");
      if (block) block.classList.remove("hidden");
    }

    function removeDisconnectFallbackFab() {
      const f = $("debtyaDisconnectFab");
      if (f) f.remove();
    }

    function showLanding() {
      removeDisconnectFallbackFab();
      landingView.classList.remove("hidden");
      authView.classList.add("hidden");
      appView.classList.add("hidden");
    }

    function showAuth(mode = "login") {
      removeDisconnectFallbackFab();
      clearPwRecoveryPending();
      hidePasswordRecoveryPanel();
      state.signupVerificationPending = false;
      state.signupVerificationEmail = null;
      state.loginVerificationPending = false;
      state.loginVerificationEmail = null;
      state.mode = mode;
      updateAuthModeUI();
      landingView.classList.add("hidden");
      authView.classList.remove("hidden");
      appView.classList.add("hidden");
    }

    function showApp() {
      landingView.classList.add("hidden");
      authView.classList.add("hidden");
      appView.classList.remove("hidden");
      patchOverviewPanelLayout();
      mountFallbackDisconnectFabIfMissing();
      void refreshSpinwheelPayableDiag();
    }

    function setNav(active) {
      if (active === "operate") void refreshMethodSection();
    }

    function fmtMoney(value) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD"
      }).format(Number(value || 0));
    }

    function fmtDate(value) {
      if (!value) return "-";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString();
    }

    function translateBillingStatus(status) {
      const s = String(status || "").toLowerCase();
      if (s === "active") return t("bill_active");
      if (s === "trialing") return t("bill_trialing");
      if (s === "inactive") return t("bill_inactive");
      if (s === "past_due") return t("bill_past_due");
      if (s === "canceled") return t("bill_canceled");
      if (s === "unpaid") return t("bill_unpaid");
      if (s === "incomplete") return t("bill_incomplete");
      if (s === "incomplete_expired") return t("bill_incomplete_expired");
      if (s === "paused") return t("bill_paused");
      return status || "-";
    }

    const toastHideTimers = new WeakMap();

    function resolveToastEl(target) {
      if (!target) return null;
      if (target.isConnected) return target;
      const id = target.id;
      return id ? document.getElementById(id) : null;
    }

    function clearToastTimer(el) {
      if (!el) return;
      const prev = toastHideTimers.get(el);
      if (prev) {
        window.clearTimeout(prev);
        toastHideTimers.delete(el);
      }
    }

    /** Toasts: se ocultan solos (?xito ~4.5s, aviso ~5.5s, error ~8s). Clic en el cartel tambi?n cierra. `persist` evita auto-cierre. */
    function showMessage(target, text, type = "success", persist = false) {
      const el = resolveToastEl(target);
      if (!el) return;
      clearToastTimer(el);
      el.onclick = null;
      el.textContent = text;
      el.classList.remove("hidden", "success", "error", "warn");
      el.classList.add(type);
      el.style.cursor = "pointer";
      el.title = t("toast_click_to_close");
      el.onclick = () => {
        el.onclick = null;
        hideMessage(el);
      };
      if (persist) return;
      const ty = String(type || "success").toLowerCase();
      const ms = ty === "error" ? 8000 : ty === "warn" ? 5500 : 4500;
      const tid = window.setTimeout(() => {
        toastHideTimers.delete(el);
        el.onclick = null;
        el.removeAttribute("title");
        el.style.cursor = "";
        el.textContent = "";
        el.classList.remove("success", "error", "warn");
        el.classList.add("hidden");
      }, ms);
      toastHideTimers.set(el, tid);
    }

    function hideMessage(target) {
      const el = resolveToastEl(target);
      if (!el) return;
      clearToastTimer(el);
      el.onclick = null;
      el.removeAttribute("title");
      el.style.cursor = "";
      el.textContent = "";
      el.classList.remove("success", "error", "warn");
      el.classList.add("hidden");
    }

    function setLoading(btn, loading, textLoading = null) {
      if (!btn) return;
      if (!btn.dataset.originalText) {
        btn.dataset.originalText = btn.textContent;
      }
      const loadLabel = textLoading || t("proc");
      btn.disabled = loading;
      btn.textContent = loading ? loadLabel : btn.dataset.originalText;
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function getStoredAccessToken() {
      try {
        const keys = Object.keys(localStorage);
        const sbKey = keys.find(k => k.includes("auth-token"));
        if (!sbKey) return null;
        const raw = localStorage.getItem(sbKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return (
          parsed?.access_token ||
          parsed?.currentSession?.access_token ||
          parsed?.session?.access_token ||
          null
        );
      } catch {
        return null;
      }
    }

    function collectJsonErrorParts(json) {
      if (!json || typeof json !== "object") return [];
      const out = [];
      const push = (v) => {
        if (v == null) return;
        const s = String(v).trim();
        if (s) out.push(s);
      };
      if (typeof json.error === "string") push(json.error);
      else if (json.error && typeof json.error === "object") push(json.error.message);
      push(json.details);
      push(json.message);
      push(json.detail);
      push(json.hint);
      push(json.description);
      if (Array.isArray(json.errors)) {
        for (const e of json.errors) {
          if (typeof e === "string") push(e);
          else if (e && typeof e === "object") push(e.message || e.msg);
        }
      }
      return out;
    }

    function isLegacyMethodInvalidEntityMessage(message) {
      const raw = String(message || "").trim();
      if (!raw) return false;
      let folded;
      try {
        folded = raw
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();
      } catch (_) {
        folded = raw.toLowerCase();
      }
      if (folded.includes("respuesta invalida de method al crear entidad")) return true;
      if (folded.includes("method al crear entidad") && folded.includes("respuesta") && folded.includes("invalida"))
        return true;
      let nfc;
      try {
        nfc = raw.normalize("NFC");
      } catch (_) {
        nfc = raw;
      }
      if (/Respuesta\s+inv[a?]lida\s+de\s+Method\s+al\s+crear\s+entidad/i.test(nfc)) return true;
      if (/Method\s+al\s+crear\s+entidad/i.test(nfc) && /inv[a?]lida/i.test(nfc) && /respuesta/i.test(nfc)) return true;
      if (
        folded.includes("respuesta") &&
        folded.includes("invalida") &&
        folded.includes("method") &&
        folded.includes("crear") &&
        folded.includes("entidad")
      ) {
        return true;
      }
      return false;
    }

    function rewriteThrownApiMessage(msg) {
      const s = String(msg || "");
      if (isLegacyMethodInvalidEntityMessage(s)) return t("err_stale_method_api");
      return s;
    }

    function normalizeErrorMessage(message) {
      const text = String(message || "").trim();

      if (!text) return t("err_generic");

      if (isLegacyMethodInvalidEntityMessage(text)) return t("err_stale_method_api");

      if (text.includes("Failed to fetch")) return t("err_fetch");
      if (text.includes("NetworkError")) return t("err_network");
      if (text.includes("Timeout")) return t("err_timeout");
      if (/HTTP 502\b|HTTP 503\b|HTTP 504\b|Bad Gateway|Gateway Timeout/i.test(text)) return t("err_upstream_unavailable");
      if (text.includes("Invalid login credentials")) return t("err_login_creds");
      if (text.includes("Email not confirmed")) return t("err_email_confirm");
      if (text.includes("Token invalido") || text.includes("sesion expirada")) return t("err_session");
      if (text.includes("No hay cuenta bancaria conectada")) return t("err_no_bank");
      if (text.includes("Falta Authorization Bearer token")) return t("err_no_auth");
      if (text.includes("Stripe no configurado")) return t("err_stripe_cfg");
      if (text.includes("Plaid no configurado")) return t("err_plaid_cfg");
      if (text.includes("Invalid linked Plaid account")) return t("err_debt_link_invalid");
      if (text.includes("Cuenta de origen no encontrada")) return t("err_plan_funding_missing");
      if (text.includes("La cuenta de origen debe ser de deposito")) return t("err_plan_funding_type");
      if (text.includes("Deuda destino no valida")) return t("err_plan_debt_invalid");
      if (text.includes("Deuda destino no encontrada")) return t("err_plan_debt_missing");
      if (text.includes("Conexion bancaria no encontrada")) return t("err_bank_not_found");

      return text;
    }

    function displayMethodSectionError(raw) {
      let s = raw != null && typeof raw === "string" ? String(raw).trim() : "";
      if (!s) s = t("method_entity_load_err_generic");
      if (isLegacyMethodInvalidEntityMessage(s)) s = t("err_stale_method_api");
      return normalizeErrorMessage(s);
    }

    async function getAccessToken() {
      const stored = getStoredAccessToken();
      if (stored) {
        localStorage.setItem("debtya_access_token", stored);
        return stored;
      }

      try {
        const { data } = await supabaseClient.auth.getSession();
        const token = data?.session?.access_token || null;
        if (token) localStorage.setItem("debtya_access_token", token);
        return token;
      } catch {
        return null;
      }
    }

    async function api(path, options = {}) {
      const token = await getAccessToken();
      const headers = { ...(options.headers || {}) };

      if (!(options.body instanceof FormData)) {
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
      }

      if (token && path !== "/health") headers.Authorization = `Bearer ${token}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(`${API_BASE}${path}`, {
          method: options.method || "GET",
          headers,
          body: options.body,
          signal: controller.signal
        });

        const text = await res.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { ok: false, raw: text };
        }

        if (!res.ok) {
          const parts = collectJsonErrorParts(json);
          let msg = [...new Set(parts)].join(" ? ").trim();
          if (!msg) {
            const raw = String(text || "").trim();
            const looksHtml = raw.startsWith("<") || /<html[\s>]/i.test(raw) || /<body[\s>]/i.test(raw);
            if (looksHtml) msg = `HTTP ${res.status} ${res.statusText || ""}`.trim();
            else if (raw) msg = raw.length > 400 ? `${raw.slice(0, 397)}...` : raw;
            else msg = `HTTP ${res.status}`;
          }
          throw new Error(rewriteThrownApiMessage(msg));
        }

        if (json && Object.prototype.hasOwnProperty.call(json, "ok") && json.ok === false) {
          const parts = collectJsonErrorParts(json);
          let msg = [...new Set(parts)].join(" ? ").trim();
          if (!msg) {
            const raw = String(text || "").trim();
            msg = raw.length > 400 ? `${raw.slice(0, 397)}...` : raw || "Respuesta inesperada del servidor";
          }
          throw new Error(rewriteThrownApiMessage(msg));
        }

        return json;
      } catch (err) {
        if (err.name === "AbortError") {
          throw new Error(`Timeout en ${path}`);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    async function fetchGuideAssistantStatus() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${API_BASE}/guide-assistant/status`, {
          signal: controller.signal
        });
        const json = await res.json().catch(() => ({}));
        return !!json.enabled;
      } catch {
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    async function postGuideAssistantMessage(message) {
      const token = await getAccessToken();
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2);
      try {
        const res = await fetch(`${API_BASE}/guide-assistant`, {
          method: "POST",
          headers,
          body: JSON.stringify({ message, lang: uiLang }),
          signal: controller.signal
        });
        const text = await res.text();
        let json = {};
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = {};
        }
        if (!res.ok) {
          const detail =
            json.details || json.error || text || `HTTP ${res.status}`;
          const err = new Error(detail);
          err.status = res.status;
          err.disabled = !!json.disabled;
          throw err;
        }
        return json.reply || "";
      } finally {
        clearTimeout(timeoutId);
      }
    }

    let guideAssistantEnabled = null;

    function updateHelpJumpFaqVisibility() {
      const btn = $("helpJumpFaqBtn");
      const land = $("landingView");
      if (!btn || !land) return;
      btn.classList.toggle("hidden", land.classList.contains("hidden"));
    }

    function appendHelpChatBubble(kind, text) {
      const log = $("helpChatLog");
      if (!log) return;
      const div = document.createElement("div");
      div.className = `help-chat-bubble ${kind}`;
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }

    async function refreshGuideAssistantBanner() {
      const off = $("helpAssistantOff");
      if (!off) return;
      if (guideAssistantEnabled === null) {
        guideAssistantEnabled = await fetchGuideAssistantStatus();
      }
      off.classList.toggle("hidden", !!guideAssistantEnabled);
    }

    function setHelpModalTab(name) {
      document.querySelectorAll(".help-tab[data-help-tab]").forEach((tab) => {
        const on = tab.getAttribute("data-help-tab") === name;
        tab.classList.toggle("active", on);
        tab.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll(".help-panel[data-help-panel]").forEach((panel) => {
        const on = panel.getAttribute("data-help-panel") === name;
        panel.classList.toggle("hidden", !on);
      });
      if (name === "ask") {
        refreshGuideAssistantBanner();
      }
      if (name === "guide") {
        updateHelpJumpFaqVisibility();
      }
    }

    function openHelpModal() {
      const root = $("helpModalRoot");
      const fab = $("helpFab");
      if (!root) return;
      root.classList.remove("hidden");
      root.setAttribute("aria-hidden", "false");
      if (fab) fab.setAttribute("aria-expanded", "true");
      guideAssistantEnabled = null;
      setHelpModalTab("guide");
    }

    function closeHelpModal() {
      const root = $("helpModalRoot");
      const fab = $("helpFab");
      if (!root) return;
      root.classList.add("hidden");
      root.setAttribute("aria-hidden", "true");
      if (fab) fab.setAttribute("aria-expanded", "false");
    }

    async function sendHelpAssistantMessage() {
      const input = $("helpChatInput");
      const sendBtn = $("helpChatSend");
      const log = $("helpChatLog");
      if (!input || !sendBtn) return;
      const msg = input.value.trim();
      if (!msg) {
        appendHelpChatBubble("err", t("guide_assistant_empty"));
        return;
      }
      appendHelpChatBubble("user", msg);
      input.value = "";
      setLoading(sendBtn, true, t("proc_loading"));
      try {
        guideAssistantEnabled = await fetchGuideAssistantStatus();
        const off = $("helpAssistantOff");
        if (off) off.classList.toggle("hidden", !!guideAssistantEnabled);
        if (!guideAssistantEnabled) {
          appendHelpChatBubble("err", t("guide_assistant_off"));
          return;
        }
        const reply = await postGuideAssistantMessage(msg);
        appendHelpChatBubble("bot", reply || "?");
      } catch (err) {
        const st = err.status;
        if (st === 429) {
          appendHelpChatBubble("err", t("guide_assistant_rate"));
        } else if (err.disabled) {
          appendHelpChatBubble("err", t("guide_assistant_off"));
          guideAssistantEnabled = false;
          const off2 = $("helpAssistantOff");
          if (off2) off2.classList.remove("hidden");
        } else {
          let raw = String(err.message || "").trim();
          if (raw.length > 500) raw = raw.slice(0, 497) + "?";
          if (!raw) {
            appendHelpChatBubble("err", t("guide_assistant_error"));
          } else {
            const n = normalizeErrorMessage(raw);
            appendHelpChatBubble("err", n !== t("err_generic") ? n : raw);
          }
        }
      } finally {
        setLoading(sendBtn, false);
        if (log) log.scrollTop = log.scrollHeight;
      }
    }

    function updateAuthModeUI() {
      const loginBtn = $("showLoginBtn");
      const signupBtn = $("showSignupBtn");
      if (state.mode === "login") {
        state.signupVerificationPending = false;
        state.signupVerificationEmail = null;
        loginBtn.className = "btn btn-primary";
        signupBtn.className = "btn btn-light";
        loginBtn.textContent = t("btn_login");
        signupBtn.textContent = t("btn_signup");
        authSubmitBtn.textContent = t("btn_login");
      } else {
        state.loginVerificationPending = false;
        state.loginVerificationEmail = null;
        signupBtn.className = "btn btn-primary";
        loginBtn.className = "btn btn-light";
        loginBtn.textContent = t("btn_login");
        signupBtn.textContent = t("btn_signup");
        authSubmitBtn.textContent = t("btn_signup");
      }
      authSubmitBtn.dataset.originalText = authSubmitBtn.textContent;
      const confirmWrap = $("authPasswordConfirmWrap");
      const confirmInput = $("authPasswordConfirm");
      if (confirmWrap) {
        confirmWrap.classList.toggle("hidden", state.mode === "login");
      }
      if (state.mode === "login" && confirmInput) {
        confirmInput.value = "";
      }
      const codeWrap = $("authSignupCodeWrap");
      const codeInput = $("authSignupVerifyCode");
      if (codeWrap) {
        const hideCode =
          (state.mode === "login" && !state.loginVerificationPending) ||
          (state.mode === "signup" && !state.signupVerificationPending);
        codeWrap.classList.toggle("hidden", hideCode);
      }
      if (state.mode === "login" && !state.loginVerificationPending && codeInput) {
        codeInput.value = "";
      }
    }

    /** Sin m?scara cuando el campo est? vac?o; al escribir pasa a type=password (m?scara solo con contenido). */
    function wireAuthPasswordMaskBehavior(pwEl, confirmEl) {
      const wire = (el) => {
        if (!el) return;
        const syncType = () => {
          if (el.value.length > 0) el.type = "password";
          else el.type = "text";
        };
        el.addEventListener("focus", syncType);
        el.addEventListener("input", syncType);
        el.addEventListener("blur", () => {
          if (!el.value) el.type = "text";
        });
        el.type = el.value ? "password" : "text";
      };
      wire(pwEl);
      wire(confirmEl);
    }

    function setBankExchangeFlag() {
      try {
        localStorage.setItem(LS_BANK_EXCHANGED, "1");
      } catch (e) {}
    }

    function hasPendingIntents() {
      return (state.intents || []).some((x) => {
        const s = String(x.status || "").toLowerCase();
        return ["draft", "pending", "built", "proposed", "ready", "pending_review"].includes(s);
      });
    }

    function completedGuideSteps() {
      const done = new Set();
      if ((state.accounts || []).length > 0) done.add("1");
      if ((state.debts || []).length > 0) done.add("2");
      if (state.plan && state.plan.id) done.add("3");
      if ((state.intents || []).length > 0 && !hasPendingIntents()) done.add("4");
      return done;
    }

    function renderGuideStepProgress() {
      const done = completedGuideSteps();
      document.querySelectorAll(".section-step-badge[data-step]").forEach((el) => {
        const step = el.getAttribute("data-step") || "";
        el.classList.toggle("is-complete", done.has(step));
      });
    }

    function scrollToAppSection(id) {
      const el = typeof id === "string" ? $(id) : id;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function computeNextStepAction() {
      const accounts = state.accounts || [];
      const debts = state.debts || [];
      const plan = state.plan;
      const rules = state.rules || [];
      const intents = state.intents || [];

      if (accounts.length === 0) {
        return {
          textKey: "next_step_bank",
          btnKey: "next_step_bank_btn",
          nav: "operate",
          scrollId: "operatePanel",
          openOperateMore: false
        };
      }
      if (debts.length === 0) {
        return {
          textKey: "next_step_debts",
          btnKey: "next_step_debts_btn",
          nav: "setup",
          scrollId: "setupPanel",
          openOperateMore: false
        };
      }
      if (!plan || !plan.id) {
        return {
          textKey: "next_step_plan",
          btnKey: "next_step_plan_btn",
          nav: "setup",
          scrollId: "paymentPlanSection",
          openOperateMore: false
        };
      }
      if (rules.length === 0) {
        return {
          textKey: "next_step_rules",
          btnKey: "next_step_rules_btn",
          nav: "setup",
          scrollId: "rulesPanel",
          openOperateMore: false
        };
      }
      if (hasPendingIntents()) {
        return {
          textKey: "next_step_review",
          btnKey: "next_step_review_btn",
          nav: "setup",
          scrollId: "suggestedPaymentsPanel",
          openOperateMore: false
        };
      }
      if (intents.length === 0) {
        return {
          textKey: "next_step_prepare",
          btnKey: "next_step_prepare_btn",
          nav: "operate",
          scrollId: "operatePanel",
          openOperateMore: true
        };
      }
      return {
        textKey: "next_step_done",
        btnKey: "next_step_done_btn",
        nav: "operate",
        scrollId: "operatePanel",
        openOperateMore: false
      };
    }

    function renderNextStepCallout() {
      const wrap = $("nextStepCallout");
      const txt = $("nextStepText");
      const btn = $("nextStepBtn");
      if (!wrap || !txt || !btn) return;
      if (!appView || appView.classList.contains("hidden")) {
        wrap.classList.add("hidden");
        return;
      }

      const step = computeNextStepAction();
      txt.textContent = t(step.textKey);
      btn.textContent = t(step.btnKey);
      btn.classList.remove("hidden");
      btn.onclick = () => {
        setNav(step.nav);
        window.requestAnimationFrame(() => {
          scrollToAppSection(step.scrollId);
          if (step.openOperateMore) {
            const det = document.querySelector("details.ux-operate-advanced");
            if (det) det.open = true;
          }
        });
      };
      wrap.classList.remove("hidden");
    }

    function updateNextActionGuide() {
      if (!appView || appView.classList.contains("hidden")) return;
      renderGuideStepProgress();
      renderNextStepCallout();
    }

    /**
     * Estima intereses evitados este mes: (balance*apr/100)/12 * min(1, pago/balance).
     * @param {object} intent
     * @param {object|null} debt
     * @returns {number|null}
     */
    function approximateMonthlyInterestSavedByPayment(intent, debt) {
      const payment = intentPaymentAmount(intent);
      if (!debt || payment <= 0) return null;
      const balance = toNum(debt.balance);
      if (balance <= 0) return null;
      const apr = parseAprValue(debt);
      if (apr === null || !Number.isFinite(apr) || apr <= 0) return null;
      const monthlyInterest = (balance * apr) / 100 / 12;
      const payVsBalance = Math.min(1, payment / balance);
      return monthlyInterest * payVsBalance;
    }

    /**
     * Monto a mostrar u ordenar para un intent (campos reales seg?n filas Supabase / legacy).
     * @param {object} intent
     */
    function intentPaymentAmount(intent) {
      if (!intent) return 0;
      let n = toNum(intent.total_amount ?? intent.amount);
      if (n > 0) return n;
      if (intent.amount_cents != null) {
        const c = toNum(intent.amount_cents);
        if (c > 0) return c / 100;
      }
      n = toNum(intent.payment_amount ?? intent.suggested_amount ?? intent.amount_due);
      if (n > 0) return n;
      const meta = normalizeIntentMetadata(intent.metadata);
      n = toNum(meta.amount ?? meta.total_amount ?? meta.suggested_amount ?? meta.payment_amount);
      return n > 0 ? n : 0;
    }

    /**
     * Intent destacado para el bloque "Tu pr?ximo paso": prioriza abiertos y mayor monto.
     * @param {object[]} intents
     */
    function pickFeaturedIntentForDashboard(intents) {
      const list = Array.isArray(intents) ? intents.filter((x) => x) : [];
      if (!list.length) return null;
      const actionableStatuses = new Set(["pending_review", "approved"]);
      const openStatuses = new Set([
        "draft",
        "pending",
        "built",
        "proposed",
        "ready",
        "pending_review",
        "approved",
        "queued"
      ]);
      const rows = list.map((intent) => {
        const st = String(intent.status || "").toLowerCase().trim();
        const isActionable = actionableStatuses.has(st);
        const isOpen = openStatuses.has(st);
        const amt = intentPaymentAmount(intent);
        const sched = intent.scheduled_for != null ? String(intent.scheduled_for) : "";
        return { intent, st, isActionable, isOpen, amt, sched };
      });
      let pool = rows.filter((r) => r.isActionable);
      if (!pool.length) {
        pool = rows.some((r) => r.isOpen) ? rows.filter((r) => r.isOpen) : rows;
      }
      pool.sort((a, b) => {
        if (a.sched && b.sched && a.sched !== b.sched) return a.sched.localeCompare(b.sched);
        return b.amt - a.amt;
      });
      return pool[0]?.intent || null;
    }

    function renderDashboardNextStep() {
      const card = $("dashboardNextStepCard");
      const primaryEl = $("dashboardNextStepPrimary");
      const secondaryEl = $("dashboardNextStepSecondary");
      const tertiaryEl = $("dashboardNextStepTertiary");
      if (!card || !primaryEl || !secondaryEl) return;

      const resetExtraLines = () => {
        secondaryEl.textContent = "";
        secondaryEl.classList.add("hidden");
        if (tertiaryEl) {
          tertiaryEl.textContent = "";
          tertiaryEl.classList.add("hidden");
        }
      };

      if (!appView || appView.classList.contains("hidden")) {
        card.classList.add("hidden");
        resetExtraLines();
        return;
      }

      const debts = Array.isArray(state.debts) ? state.debts : [];
      const intents = Array.isArray(state.intents) ? state.intents : [];

      resetExtraLines();
      card.classList.remove("hidden");

      if (debts.length === 0) {
        primaryEl.textContent = t("dashboard_next_no_debts");
        return;
      }
      if (intents.length === 0) {
        primaryEl.textContent = t("dashboard_next_no_intents");
        return;
      }

      const intent = pickFeaturedIntentForDashboard(intents);
      if (!intent) {
        primaryEl.textContent = t("dashboard_next_no_intents");
        return;
      }
      const amount = fmtMoney(intentPaymentAmount(intent));
      let debtLabel = describeIntentPayToward(intent);
      if (!debtLabel || debtLabel === "?" || !String(debtLabel).trim()) {
        debtLabel = t("dashboard_debt_fallback");
      }
      primaryEl.textContent = tf("dashboard_next_pay_line", { amount, debt: debtLabel });

      const did = String(intent.debt_id || "").trim();
      const debtRow = did ? debts.find((d) => String(d.id) === did) : null;
      const savings = approximateMonthlyInterestSavedByPayment(intent, debtRow);
      secondaryEl.textContent =
        savings !== null
          ? tf("dashboard_next_interest_saved", { amount: fmtMoney(savings) })
          : t("dashboard_next_interest_na");
      secondaryEl.classList.remove("hidden");
      if (tertiaryEl) {
        tertiaryEl.textContent = t("dashboard_next_accel");
        tertiaryEl.classList.remove("hidden");
      }
    }

    function renderStats() {
      const totalDebt = state.debts.reduce((sum, d) => sum + Number(d.balance || 0), 0);
      const pending = state.intents.filter(x =>
        ["draft","pending","built","proposed","ready","pending_review","approved"].includes(String(x.status || "").toLowerCase())
      ).length;
      const executed = state.intents.filter(x => String(x.status || "").toLowerCase() === "executed").length;

      $("statDebtTotal").textContent = fmtMoney(totalDebt);
      $("statDebtCount").textContent = String(state.debts.length);
      $("statPendingIntents").textContent = String(pending);
      $("statExecutedIntents").textContent = String(executed);
      renderPayoffSimulation();
      renderDashboardNextStep();
    }

    function toNum(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }

    function parseAprValue(debt) {
      const raw = debt?.apr ?? debt?.interest_rate ?? null;
      if (raw === null || raw === undefined || raw === "") return null;
      const cleaned = String(raw).replace("%", "").replace(",", ".").trim();
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }

    function renderPayoffSimulation() {
      const totalEl = $("simTotalDebtBalance");
      const minEl = $("simTotalMinimumPayment");
      const urgentEl = $("simUrgentDebtByApr");
      const strategyEl = $("simRecommendedStrategy");
      const countsEl = $("simCountsLine");
      if (!totalEl || !minEl || !urgentEl || !strategyEl || !countsEl) return;

      const debts = Array.isArray(state.debts) ? state.debts : [];
      const totalDebtBalance = debts.reduce((sum, d) => sum + toNum(d.balance), 0);
      const totalMinimumPayment = debts.reduce((sum, d) => sum + toNum(d.minimum_payment), 0);
      const activeDebts = debts.filter((d) => toNum(d.balance) > 0).length;

      let urgentDebt = null;
      let urgentApr = -1;
      debts.forEach((debt) => {
        const apr = parseAprValue(debt);
        if (apr !== null && apr > urgentApr) {
          urgentApr = apr;
          urgentDebt = debt;
        }
      });

      const strategy = urgentDebt ? "Avalanche" : "Snowball";
      totalEl.textContent = fmtMoney(totalDebtBalance);
      minEl.textContent = fmtMoney(totalMinimumPayment);
      strategyEl.textContent = strategy;
      countsEl.textContent = `${t("sim_counts_active_label")}: ${activeDebts}`;

      if (urgentDebt) {
        const debtName = String(urgentDebt.name || urgentDebt.id || "Deuda sin nombre");
        urgentEl.textContent = `${debtName} (${urgentApr.toFixed(2)}% APR)`;
      } else {
        urgentEl.textContent = "Sin datos de APR por ahora.";
      }

      const aprValues = debts
        .map((d) => parseAprValue(d))
        .filter((a) => a !== null && Number.isFinite(a) && a > 0);
      const avgApr = aprValues.length ? aprValues.reduce((s, a) => s + a, 0) / aprValues.length : 0;
      const annualInterestApprox = totalDebtBalance * (avgApr / 100);
      const savingsEstimate = annualInterestApprox * 0.25;
      const savingsLineEl = $("simSavingsLine");
      const monthsLineEl = $("simMonthsLine");
      if (savingsLineEl && monthsLineEl) {
        savingsLineEl.textContent = `Ahorro estimado: ~${fmtMoney(savingsEstimate)}`;
        let reducedMonths = 1;
        if (savingsEstimate > 0 && totalMinimumPayment > 0) {
          reducedMonths = Math.round(savingsEstimate / Math.max(totalMinimumPayment * 0.25, 20));
          reducedMonths = Math.max(1, Math.min(48, reducedMonths));
        } else if (savingsEstimate > 0) {
          reducedMonths = Math.max(1, Math.min(36, Math.round(Math.sqrt(totalDebtBalance + 1) / 15)));
        }
        monthsLineEl.textContent =
          reducedMonths === 1
            ? "Tiempo estimado reducido: ~1 mes"
            : `Tiempo estimado reducido: ~${reducedMonths} meses`;
      }
    }

    function normalizeIntentMetadata(raw) {
      if (raw == null) return {};
      if (typeof raw === "string") {
        try {
          const p = JSON.parse(raw);
          return typeof p === "object" && p && !Array.isArray(p) ? p : {};
        } catch {
          return {};
        }
      }
      return typeof raw === "object" && raw && !Array.isArray(raw) ? raw : {};
    }

    function formatIntentReasonHtml(intent) {
      try {
        const meta = normalizeIntentMetadata(intent.metadata);
        const did = intent.debt_id != null ? String(intent.debt_id) : "";
        const debt =
          (Array.isArray(state.debts) ? state.debts : []).find((d) => d && String(d.id) === did) || null;

        const rawApr = debt ? debt.apr ?? debt.interest_rate : null;
        let apr = null;
        if (rawApr !== null && rawApr !== undefined && rawApr !== "") {
          const cleaned = String(rawApr).replace("%", "").replace(",", ".").trim();
          const n = Number(cleaned);
          if (Number.isFinite(n)) apr = n;
        }
        if (apr === null && meta.interest_rate != null && meta.interest_rate !== "") {
          const n = Number(meta.interest_rate);
          if (Number.isFinite(n)) apr = n;
        }

        let balance = debt != null ? toNum(debt.balance) : NaN;
        if (!Number.isFinite(balance)) {
          const b = Number(meta.balance_snapshot);
          if (Number.isFinite(b)) balance = b;
        }

        const stratRaw = String(
          intent.strategy || meta.strategy || state.plan?.strategy || ""
        ).toLowerCase();
        const isAvalanche = stratRaw === "avalanche";
        const isSnowball = stratRaw === "snowball";

        const parts = [];
        if (apr !== null && apr >= 20) {
          parts.push(`Alta prioridad por APR alto (${apr.toFixed(0)}%)`);
        } else if (Number.isFinite(balance) && balance < 500) {
          parts.push("Balance bajo, se puede eliminar r\u00E1pido");
        } else {
          parts.push("Pago recomendado seg\u00fan tu plan");
        }
        if (Number.isFinite(balance)) {
          parts.push(`Balance actual: ${fmtMoney(balance)}`);
        }
        const hasValidApr = apr !== null && Number.isFinite(apr) && apr > 0;
        if (!hasValidApr) {
          parts.push("Tasa de inter\u00E9s no disponible");
        } else if (Number.isFinite(balance) && balance >= 0) {
          const monthlyInterest = (balance * apr) / 100 / 12;
          if (!Number.isFinite(monthlyInterest)) {
            parts.push("Tasa de inter\u00E9s no disponible");
          } else if (monthlyInterest >= 1) {
            parts.push(`Intereses mensuales aprox: ${fmtMoney(monthlyInterest)}`);
          } else {
            parts.push("Intereses muy bajos actualmente");
          }
        }
        if (isAvalanche) parts.push("Reduce intereses totales");
        if (isSnowball) parts.push("Ayuda a cerrar cuentas m\u00E1s r\u00E1pido");

        const inner = parts.map((p) => escapeHtml(p)).join("<br />");
        return `<div class="intent-reason">${inner}</div>`;
      } catch {
        return `<div class="intent-reason">${escapeHtml("Pago recomendado seg\u00fan tu plan")}</div>`;
      }
    }

    function renderDebtTargetOptions() {
      const select = $("ruleTargetDebt");
      select.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = t("debt_select_placeholder");
      select.appendChild(empty);

      state.debts.forEach((debt) => {
        const op = document.createElement("option");
        op.value = debt.id;
        op.textContent = `${debt.name} - ${fmtMoney(debt.balance)}`;
        select.appendChild(op);
      });
    }

    function findAccountForDebt(debt) {
      const pid = debt.linked_plaid_account_id;
      if (!pid) return null;
      return state.accounts.find((a) => a.plaid_account_id === pid) || null;
    }

    function buildAccountOptionLabel(acc) {
      const mask = acc.mask ? ` ? ****${escapeHtml(acc.mask)}` : "";
      return `${escapeHtml(acc.name || t("acct_default"))}${mask} (${escapeHtml(acc.type || "-")})`;
    }

    function buildDebtPlaidSelectOptionsHtml(selectedPlaidId) {
      let html = `<option value="">${escapeHtml(t("debt_link_none"))}</option>`;
      state.accounts.forEach((acc) => {
        const id = acc.plaid_account_id || "";
        const sel = selectedPlaidId && id === selectedPlaidId ? " selected" : "";
        html += `<option value="${escapeHtml(id)}"${sel}>${buildAccountOptionLabel(acc)}</option>`;
      });
      return html;
    }

    function linkedPlaidInfoHtml(debt) {
      const linked = findAccountForDebt(debt);
      if (debt.linked_plaid_account_id && !linked) {
        return `<div class="notice warn" style="margin-top:10px;">${escapeHtml(t("debt_link_orphan"))}</div>`;
      }
      if (!linked) return "";

      const manual = Number(debt.balance || 0);
      const rawImported = Number(linked.current_balance ?? linked.balance_current ?? 0);
      const importedOwed = Math.abs(rawImported);
      const diff = Math.abs(manual - importedOwed);
      const same = diff < 0.015;

      const maskRow = linked.mask
        ? `<div class="debt-plaid-kv"><span class="debt-plaid-k">${escapeHtml(t("debt_link_mask_label"))}</span><span class="debt-plaid-v">****${escapeHtml(String(linked.mask))}</span></div>`
        : "";

      const compareNote = same
        ? `<div class="debt-balance-match-note">${escapeHtml(t("debt_balance_match_hint"))}</div>`
        : `<div class="notice warn debt-balance-mismatch">${escapeHtml(t("debt_balance_mismatch_hint"))}</div>`;

      const syncBtn = same
        ? ""
        : `<div class="debt-sync-balance-wrap">
            <button type="button" class="btn btn-primary btn-small debt-sync-balance-btn" data-debt-id="${escapeHtml(debt.id)}" data-target-balance="${escapeHtml(String(importedOwed))}">${escapeHtml(t("btn_sync_imported_balance"))}</button>
          </div>`;

      return `
        <div class="debt-plaid-panel">
          <div class="debt-plaid-panel-top">
            <span class="debt-plaid-badge">${escapeHtml(t("debt_link_badge"))}</span>
          </div>
          <div class="debt-plaid-details">
            <div class="debt-plaid-kv"><span class="debt-plaid-k">${escapeHtml(t("debt_link_account_label"))}</span><span class="debt-plaid-v"><strong>${escapeHtml(linked.name || t("acct_default"))}</strong></span></div>
            ${maskRow}
            <div class="debt-plaid-kv"><span class="debt-plaid-k">${escapeHtml(t("acct_type"))}</span><span class="debt-plaid-v">${escapeHtml(linked.type || "?")}</span></div>
            <div class="debt-plaid-kv"><span class="debt-plaid-k">${escapeHtml(t("acct_subtype"))}</span><span class="debt-plaid-v">${escapeHtml(linked.subtype || "?")}</span></div>
          </div>
          <div class="debt-balance-compare">
            <div class="debt-balance-box">
              <div class="debt-balance-k">${escapeHtml(t("debt_balance_manual_label"))}</div>
              <div class="debt-balance-amt">${fmtMoney(manual)}</div>
            </div>
            <div class="debt-balance-box debt-balance-box-import">
              <div class="debt-balance-k">${escapeHtml(t("debt_balance_imported_label"))}</div>
              <div class="debt-balance-amt">${fmtMoney(importedOwed)}</div>
            </div>
          </div>
          ${compareNote}
          ${syncBtn}
        </div>`;
    }

    function populateDebtFormLinkedSelect() {
      const sel = $("debtLinkedPlaid");
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = buildDebtPlaidSelectOptionsHtml(null);
      if (prev && state.accounts.some((a) => a.plaid_account_id === prev)) sel.value = prev;
      else sel.value = "";
    }

    function getPlaidAccountsEligibleForDebt() {
      return (state.accounts || []).filter((a) => {
        const ty = String(a.type || "").toLowerCase();
        return (ty === "credit" || ty === "loan") && !!a.plaid_account_id;
      });
    }

    function mapPlaidAccountToDebtType(acc) {
      const ty = String(acc.type || "").toLowerCase();
      const st = String(acc.subtype || "").toLowerCase();
      if (ty === "credit") {
        if (st === "credit card" || st === "paypal") return "credit_card";
        return "other";
      }
      if (ty === "loan") {
        if (st.includes("personal") || st === "consumer") return "personal_loan";
        return "loan";
      }
      return "other";
    }

    function suggestFriendlyDebtName(rawName, acc) {
      let s = String(rawName || "").replace(/\s+/g, " ").trim();
      if (!s) {
        const dt = mapPlaidAccountToDebtType(acc);
        if (dt === "personal_loan") return t("debt_suggest_personal_loan");
        if (dt === "loan") return t("debt_suggest_loan");
        if (dt === "credit_card" || String(acc.type || "").toLowerCase() === "credit") return t("debt_suggest_credit");
        return t("acct_default");
      }

      s = s.replace(/\s*\*{2,}\s*\d+\s*$/i, "");
      s = s.replace(/\s*\*{2,}\d+\s*$/i, "");
      s = s.replace(/\s+\(\d{3,4}\)\s*$/g, "");
      s = s.replace(/\s+x{1,}\d{4,}\s*$/i, "");
      s = s.replace(/\s+#+\s*\d+\s*$/i, "");
      s = s.replace(/\s+\d{4}\s*$/g, "");
      s = s.replace(/\s+\d{5,}\s*$/g, "");
      s = s.replace(/\s+account\s+\d+\s*$/i, "");
      s = s.replace(/\s+account\s*$/i, "");
      s = s.replace(/\s+/g, " ").trim();

      const suffixCuts = [
        /\s+visa\b/i,
        /\s+mastercard\b/i,
        /\s+american express\b/i,
        /\s+amex\b/i,
        /\s+discover\b/i,
        /\s+platinum\b/i,
        /\s+signature\b/i,
        /\s+preferred\b/i,
        /\s+rewards?\b/i,
        /\s+cash\s+back\b/i,
        /\s+world\s+elite\b/i
      ];
      for (const re of suffixCuts) {
        const m = s.match(re);
        if (m && m.index > 0) {
          s = s.slice(0, m.index).trim();
          break;
        }
      }

      const words = s.split(/\s+/).map((w) => {
        if (!w) return w;
        if (/^\d+$/.test(w)) return w;
        if (w.length <= 1) return w.toUpperCase();
        if (/^[A-Z0-9&.-]+$/.test(w) && /[A-Z]/.test(w) && w.length > 2 && !/[a-z]/.test(w)) {
          return w[0] + w.slice(1).toLowerCase();
        }
        return w;
      });
      s = words.join(" ").replace(/\s+/g, " ").trim();

      if (s.length > 48) {
        s = s.slice(0, 48).replace(/\s+\S*$/, "").trim();
      }

      if (!s || s.length < 2) {
        const dt = mapPlaidAccountToDebtType(acc);
        if (dt === "personal_loan") return t("debt_suggest_personal_loan");
        if (dt === "loan") return t("debt_suggest_loan");
        return t("debt_suggest_credit");
      }

      return s;
    }

    function pickNumericMinPaymentCandidate(acc) {
      if (!acc || typeof acc !== "object") return null;
      const payload = acc.payload_json && typeof acc.payload_json === "object" ? acc.payload_json : {};
      const rawJson = acc.raw_json && typeof acc.raw_json === "object" ? acc.raw_json : {};
      const keys = [
        acc.minimum_payment,
        acc.minimum_payment_amount,
        acc.min_payment,
        acc.min_payment_amount,
        acc.monthly_payment,
        acc.next_monthly_payment,
        payload.minimum_payment,
        payload.minimum_payment_amount,
        payload.min_payment,
        rawJson.minimum_payment,
        rawJson.minimum_payment_amount,
        rawJson.min_payment
      ];
      for (const v of keys) {
        if (v === undefined || v === null || v === "") continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) continue;
        return n;
      }
      return null;
    }

    function suggestMinPaymentFromImportedAccount(acc) {
      const fallback = 25;
      const n = pickNumericMinPaymentCandidate(acc);
      if (n === null) return { value: fallback, fromImport: false };

      const bal = Math.abs(Number(acc.current_balance ?? acc.balance_current ?? 0));
      if (n > 200000) return { value: fallback, fromImport: false };
      if (bal > 0 && n > bal * 5) return { value: fallback, fromImport: false };
      const rounded = Math.round(n * 100) / 100;
      if (rounded <= 0) return { value: fallback, fromImport: false };
      return { value: rounded, fromImport: true };
    }

    function normalizeImportedAprNumber(n) {
      if (!Number.isFinite(n) || n <= 0) return null;
      let pct = n;
      if (n > 0 && n < 1) pct = n * 100;
      if (pct < 1 || pct > 80) return null;
      return Math.round(pct * 100) / 100;
    }

    function pickAprCandidate(acc) {
      if (!acc || typeof acc !== "object") return null;
      const payload = acc.payload_json && typeof acc.payload_json === "object" ? acc.payload_json : {};
      const rawJson = acc.raw_json && typeof acc.raw_json === "object" ? acc.raw_json : {};
      const singles = [
        acc.apr,
        acc.apr_rate,
        acc.interest_rate,
        acc.annual_percentage_rate,
        acc.annual_percentage_yield,
        payload.apr,
        payload.interest_rate,
        payload.annual_percentage_rate,
        rawJson.apr,
        rawJson.interest_rate,
        rawJson.annual_percentage_rate
      ];
      for (const v of singles) {
        if (v === undefined || v === null || v === "") continue;
        const num = Number(v);
        if (Number.isFinite(num) && num > 0) return num;
      }
      const aprs = rawJson.aprs || payload.aprs;
      if (Array.isArray(aprs)) {
        for (const row of aprs) {
          if (!row || typeof row !== "object") continue;
          const p = Number(row.apr_percentage ?? row.apr);
          if (Number.isFinite(p) && p > 0) return p;
        }
      }
      return null;
    }

    function suggestAprFromImportedAccount(acc) {
      const fallback = 19.99;
      const raw = pickAprCandidate(acc);
      if (raw === null) return { value: fallback, fromImport: false };
      const normalized = normalizeImportedAprNumber(raw);
      if (normalized === null) return { value: fallback, fromImport: false };
      return { value: normalized, fromImport: true };
    }

    function updateDebtSuggestedFieldHighlights(aprFromImport, minFromImport) {
      const aprEl = $("debtApr");
      const minEl = $("debtMinPayment");
      const aprField = aprEl && aprEl.closest ? aprEl.closest(".field") : null;
      const minField = minEl && minEl.closest ? minEl.closest(".field") : null;
      if (aprField) aprField.classList.toggle("debt-field-suggested", !!aprFromImport);
      if (minField) minField.classList.toggle("debt-field-suggested", !!minFromImport);
    }

    function fillDebtFormFromPlaidAccount(plaidAccountId) {
      const acc = state.accounts.find((a) => String(a.plaid_account_id || "") === String(plaidAccountId || ""));
      if (!acc) return;
      const rawBal = Number(acc.current_balance ?? acc.balance_current ?? 0);
      $("debtName").value = suggestFriendlyDebtName(acc.name || "", acc);
      const nameHint = $("debtNameSuggestedHint");
      if (nameHint) {
        nameHint.textContent = t("debt_name_suggested_hint");
        nameHint.classList.remove("hidden");
      }
      $("debtBalance").value = String(Math.abs(rawBal));
      $("debtType").value = mapPlaidAccountToDebtType(acc);
      const aprSug = suggestAprFromImportedAccount(acc);
      $("debtApr").value = String(aprSug.value);
      const aprHint = $("debtAprSuggestedHint");
      if (aprHint) {
        if (aprSug.fromImport) {
          aprHint.textContent = t("debt_apr_from_import_hint");
          aprHint.classList.remove("hidden");
        } else {
          aprHint.classList.add("hidden");
        }
      }
      const minSug = suggestMinPaymentFromImportedAccount(acc);
      $("debtMinPayment").value = String(minSug.value);
      const minHint = $("debtMinPaymentSuggestedHint");
      if (minHint) {
        if (minSug.fromImport) {
          minHint.textContent = t("debt_min_from_import_hint");
          minHint.classList.remove("hidden");
        } else {
          minHint.classList.add("hidden");
        }
      }
      updateDebtSuggestedFieldHighlights(aprSug.fromImport, minSug.fromImport);
      $("debtDueDay").value = "";
      populateDebtFormLinkedSelect();
      const pid = acc.plaid_account_id || "";
      const linkSel = $("debtLinkedPlaid");
      if (linkSel && pid) linkSel.value = pid;
    }

    function populateDebtFromAccountSelect() {
      const sel = $("debtFromAccountSelect");
      if (!sel) return;
      const prev = sel.value;
      const eligible = getPlaidAccountsEligibleForDebt()
        .slice()
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
      let html = `<option value="">${escapeHtml(t("debt_from_account_none"))}</option>`;
      eligible.forEach((acc) => {
        const id = acc.plaid_account_id || "";
        if (!id) return;
        const maskBit = acc.mask ? ` ? ****${escapeHtml(String(acc.mask))}` : "";
        const label = `${escapeHtml(acc.name || t("acct_default"))}${maskBit}`;
        const pick = prev === id ? " selected" : "";
        html += `<option value="${escapeHtml(id)}"${pick}>${label}</option>`;
      });
      sel.innerHTML = html;
      if (prev && eligible.some((a) => String(a.plaid_account_id) === String(prev))) sel.value = prev;
      else sel.value = "";
    }

    function renderDebts() {
      const box = $("debtsList");
      box.innerHTML = "";

      if (!state.debts.length) {
        box.innerHTML = `<div class="empty">${escapeHtml(t("empty_debts"))}</div>`;
        renderStats();
        renderDebtTargetOptions();
        populateDebtFormLinkedSelect();
        populateDebtFromAccountSelect();
        populatePlanRoutingSelects();
        syncRuleFormFromSavedRule();
        updateNextActionGuide();
        return;
      }

      const highestBalance = Math.max(...state.debts.map(d => Number(d.balance || 0)), 1);

      state.debts.forEach((debt) => {
        const progress = Math.max(5, Math.min(100, (Number(debt.balance || 0) / highestBalance) * 100));
        const el = document.createElement("div");
        const linkedAcc = findAccountForDebt(debt);
        const hasGoodLink = !!(debt.linked_plaid_account_id && linkedAcc);
        el.className = hasGoodLink ? "item debt-item-linked" : "item";
        const linkInfo = linkedPlaidInfoHtml(debt);
        const selPlaid = debt.linked_plaid_account_id || "";
        const linkPill = hasGoodLink
          ? `<span class="pill blue debt-linked-title-pill">${escapeHtml(t("debt_link_badge_short"))}</span>`
          : "";
        const src = String(debt.source || "manual");
        const sourcePills = [];
        if (src === "spinwheel") {
          sourcePills.push(`<span class="pill teal debt-source-pill">${escapeHtml(t("debt_source_spinwheel"))}</span>`);
          if (debt.payment_capable) {
            sourcePills.push(`<span class="pill green">${escapeHtml(t("debt_spinwheel_payable"))}</span>`);
          } else {
            sourcePills.push(`<span class="pill gray">${escapeHtml(t("debt_spinwheel_plan_only"))}</span>`);
          }
        } else if (src === "plaid") {
          sourcePills.push(`<span class="pill purple">${escapeHtml(t("debt_source_plaid"))}</span>`);
        }
        const sourcePillsHtml = sourcePills.join("");
        el.innerHTML = `
          <div class="item-top">
            <div>
              <div class="item-title-wrap">
                <div class="item-title">${escapeHtml(debt.name || t("debt_label"))}</div>
                ${linkPill}${sourcePillsHtml}
              </div>
              <div class="item-meta">
                ${escapeHtml(t("apr_label"))}: <strong>${Number(debt.apr || 0).toFixed(2)}%</strong> ?
                ${escapeHtml(t("min_label"))}: <strong>${fmtMoney(debt.minimum_payment)}</strong> ?
                ${escapeHtml(t("day_label"))}: <strong>${debt.due_day ?? "-"}</strong> ?
                ${escapeHtml(t("type_label"))}: <strong>${escapeHtml(
                  debt.type === "credit_card" ? t("debt_type_cc") :
                  debt.type === "personal_loan" ? t("debt_type_pl") :
                  debt.type === "loan" ? t("debt_type_loan") :
                  debt.type === "other" ? t("debt_type_other") :
                  debt.type || "-"
                )}</strong>
              </div>
            </div>
            <div class="right">
              <div class="money">${fmtMoney(debt.balance)}</div>
              <div class="muted" style="font-size:12px;margin-top:4px;">${escapeHtml(t("updated_label"))}: ${fmtDate(debt.updated_at)}</div>
            </div>
          </div>
          ${linkInfo}
          <div class="progress"><span style="width:${progress}%"></span></div>
          <div class="debt-plaid-row">
            <span class="label" data-i18n="lbl_link_plaid">Linked bank account (optional)</span>
            <select class="select debt-plaid-select" data-debt-id="${escapeHtml(debt.id)}">
              ${buildDebtPlaidSelectOptionsHtml(selPlaid)}
            </select>
          </div>
        `;
        box.appendChild(el);
      });

      document.querySelectorAll("#debtsList [data-i18n]").forEach((node) => {
        const k = node.getAttribute("data-i18n");
        if (k) node.textContent = t(k);
      });

      renderStats();
      renderDebtTargetOptions();
      populateDebtFormLinkedSelect();
      populateDebtFromAccountSelect();
      populatePlanRoutingSelects();
      syncRuleFormFromSavedRule();
      updateNextActionGuide();
    }

    function ruleModeListTitle(mode) {
      const m = String(mode || "");
      if (m === "fixed_amount") return t("rule_way_monthly_fixed");
      if (m === "roundup_percent") return t("rule_way_purchase_percent");
      if (m === "roundup_change") return t("rule_way_spare_change");
      return m || "rule";
    }

    function ruleListMetaLines(rule) {
      const m = String(rule.mode || "");
      const parts = [];
      if (m === "fixed_amount") {
        parts.push(`${escapeHtml(t("rule_fixed_lbl"))}: <strong>${fmtMoney(rule.fixed_amount)}</strong>`);
      }
      if (m === "roundup_percent") {
        parts.push(`${escapeHtml(t("rule_pct_label"))}: <strong>${Number(rule.percent || 0)}%</strong>`);
        if (Number(rule.min_purchase_amount || 0) > 0) {
          parts.push(
            `${escapeHtml(t("rule_min_purchase_lbl"))}: <strong>${fmtMoney(rule.min_purchase_amount)}</strong>`
          );
        }
      }
      if (m === "roundup_change") {
        parts.push(
          `${escapeHtml(t("lbl_roundup_step"))}: <strong>${fmtMoney(rule.roundup_to || 1)}</strong>`
        );
        if (Number(rule.min_purchase_amount || 0) > 0) {
          parts.push(
            `${escapeHtml(t("rule_min_purchase_lbl"))}: <strong>${fmtMoney(rule.min_purchase_amount)}</strong>`
          );
        }
      }
      if (!parts.length) {
        parts.push(`${escapeHtml(t("rule_pct_label"))}: <strong>${Number(rule.percent || 0)}%</strong>`);
        parts.push(`${escapeHtml(t("rule_fixed_lbl"))}: <strong>${fmtMoney(rule.fixed_amount)}</strong>`);
        parts.push(`${escapeHtml(t("rule_roundup_lbl"))}: <strong>${fmtMoney(rule.roundup_to || 0)}</strong>`);
        parts.push(
          `${escapeHtml(t("rule_min_purchase_lbl"))}: <strong>${fmtMoney(rule.min_purchase_amount || 0)}</strong>`
        );
      }
      return parts.join(" ? ");
    }

    function syncRuleModeFields() {
      const modeEl = $("ruleMode");
      if (!modeEl) return;
      const m = modeEl.value;
      const fixed = $("ruleFieldsFixed");
      const pct = $("ruleFieldsPercent");
      const ru = $("ruleFieldsRoundup");
      if (fixed) fixed.classList.toggle("hidden", m !== "fixed_amount");
      if (pct) pct.classList.toggle("hidden", m !== "roundup_percent");
      if (ru) ru.classList.toggle("hidden", m !== "roundup_change");
    }

    function updateRuleModeHint() {
      const el = $("ruleModeHint");
      if (!el) return;
      const m = $("ruleMode")?.value || "fixed_amount";
      const key =
        m === "roundup_percent"
          ? "rule_mode_hint_percent"
          : m === "roundup_change"
            ? "rule_mode_hint_roundup"
            : "rule_mode_hint_fixed";
      el.textContent = t(key);
    }

    function getRuleMinPurchaseForSubmit() {
      const m = $("ruleMode")?.value || "fixed_amount";
      if (m === "roundup_percent") return Number($("ruleMinPurchasePercent")?.value || 0);
      if (m === "roundup_change") return Number($("ruleMinPurchaseRoundup")?.value || 0);
      return 0;
    }

    function syncRuleSubmitLabel() {
      const btn = $("createRuleBtn");
      if (!btn) return;
      if (state.editingRuleId) {
        btn.removeAttribute("data-i18n");
        btn.textContent = t("btn_save_rule_changes");
      } else {
        btn.setAttribute("data-i18n", "btn_save_rule");
        btn.textContent = t("btn_save_rule");
      }
    }

    function normalizeRuleModeForForm(mode) {
      const m = String(mode || "").toLowerCase();
      if (m === "roundup_percent" || m === "fixed_amount" || m === "roundup_change") return m;
      if (["monthly_fixed", "fixed"].includes(m)) return "fixed_amount";
      if (["purchase_percent", "spend_percent", "percent_of_spend"].includes(m)) return "roundup_percent";
      if (["spare_change", "roundup_next", "round_up", "roundup_dollar"].includes(m)) return "roundup_change";
      return "fixed_amount";
    }

    function syncRuleFormFromSavedRule() {
      if ((state.rules || []).length !== 1 || state.editingRuleId) return;
      renderDebtTargetOptions();
      populateRuleFormFromRule(state.rules[0]);
    }

    function populateRuleFormFromRule(rule) {
      if (!rule) return;
      const modeEl = $("ruleMode");
      if (modeEl) modeEl.value = normalizeRuleModeForForm(rule.mode);
      const fa = $("ruleFixedAmount");
      if (fa) fa.value = String(rule.fixed_amount ?? 0);
      const pct = $("rulePercent");
      if (pct) pct.value = String(rule.percent ?? 0);
      const ru = $("ruleRoundupTo");
      if (ru) ru.value = String(rule.roundup_to && Number(rule.roundup_to) > 0 ? rule.roundup_to : 1);
      const mpPct = $("ruleMinPurchasePercent");
      if (mpPct) mpPct.value = String(rule.min_purchase_amount ?? 0);
      const mpRu = $("ruleMinPurchaseRoundup");
      if (mpRu) mpRu.value = String(rule.min_purchase_amount ?? 0);
      const td = $("ruleTargetDebt");
      if (td) td.value = rule.target_debt_id || "";
    }

    function syncHeroRulesSwitch() {
      const wrap = $("heroRuleSwitchWrap");
      const sw = $("heroRulesEnabledSwitch");
      if (!wrap || !sw) return;
      const rules = state.rules || [];
      if (rules.length !== 1) {
        wrap.classList.add("hidden");
        return;
      }
      wrap.classList.remove("hidden");
      const r = rules[0];
      sw.checked = !!r.enabled;
    }

    function updateRuleFormLock() {
      const form = $("ruleForm");
      if (!form) return;
      const hasRule = Array.isArray(state.rules) && state.rules.length > 0;
      const editing = !!state.editingRuleId;
      const locked = hasRule && !editing;
      const hint = $("ruleLimitHint");
      if (hint) hint.classList.toggle("hidden", !hasRule);
      const cancelBtn = $("ruleCancelEditBtn");
      if (cancelBtn) cancelBtn.classList.toggle("hidden", !editing);
      form.querySelectorAll("input, select, textarea, button").forEach((el) => {
        if (el.id === "ruleCancelEditBtn") {
          el.disabled = false;
          return;
        }
        el.disabled = locked;
      });
      syncRuleSubmitLabel();
    }

    function renderRules() {
      const box = $("rulesList");
      if (!box) return;
      box.innerHTML = "";

      if (!state.rules.length) {
        state.editingRuleId = null;
        box.innerHTML = `<div class="empty">${escapeHtml(t("empty_rules"))}</div>`;
        updateRuleFormLock();
        syncHeroRulesSwitch();
        return;
      }

      state.rules.forEach((rule) => {
        const pillClass = rule.enabled ? "green" : "red";
        const modeLabel = ruleModeListTitle(rule.mode);
        const ruleId = String(rule.id || "").trim();
        const ruleIdJs = ruleId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

        const item = document.createElement("div");
        item.className = "item";
        item.innerHTML = `
          <div class="item-top">
            <div>
              <div class="item-title">${escapeHtml(modeLabel)}</div>
              <div class="item-meta">${ruleListMetaLines(rule)}</div>
            </div>
            <div>
              <span class="pill ${pillClass}">${rule.enabled ? t("rule_active") : t("rule_inactive")}</span>
            </div>
          </div>
          <div class="item-actions">
            <button class="btn btn-light btn-small" type="button" onclick="beginEditRule('${ruleIdJs}')">${escapeHtml(t("btn_edit_rule"))}</button>
            <button class="btn btn-danger btn-small" type="button" onclick="deleteRule('${ruleIdJs}')">${escapeHtml(t("btn_delete_rule"))}</button>
          </div>
        `;
        box.appendChild(item);
      });
      updateRuleFormLock();
      syncHeroRulesSwitch();
      syncRuleFormFromSavedRule();
    }

    function statusPill(status) {
      const s = String(status || "").toLowerCase();
      if (s === "executed") return `<span class="pill green">${escapeHtml(t("pill_executed"))}</span>`;
      if (s === "approved") return `<span class="pill blue">${escapeHtml(t("pill_approved"))}</span>`;
      if (s === "active") return `<span class="pill green">${escapeHtml(t("pill_active"))}</span>`;
      if (s === "trialing") return `<span class="pill blue">${escapeHtml(t("pill_trialing"))}</span>`;
      if (s === "inactive") return `<span class="pill red">${escapeHtml(t("pill_inactive"))}</span>`;
      if (s === "draft") return `<span class="pill orange">${escapeHtml(t("pill_draft"))}</span>`;
      if (s === "pending") return `<span class="pill orange">${escapeHtml(t("pill_pending"))}</span>`;
      if (s === "built") return `<span class="pill orange">${escapeHtml(t("pill_built"))}</span>`;
      if (s === "proposed") return `<span class="pill orange">${escapeHtml(t("pill_proposed"))}</span>`;
      if (s === "ready") return `<span class="pill orange">${escapeHtml(t("pill_ready"))}</span>`;
      if (s === "pending_review") return `<span class="pill orange">${escapeHtml(t("pill_pending_review"))}</span>`;
      if (s === "past_due") return `<span class="pill orange">${escapeHtml(t("pill_past_due"))}</span>`;
      if (s === "canceled") return `<span class="pill orange">${escapeHtml(t("pill_canceled"))}</span>`;
      if (s === "unpaid") return `<span class="pill orange">${escapeHtml(t("pill_unpaid"))}</span>`;
      if (s === "avalanche") return `<span class="pill blue">${escapeHtml(t("strategy_avalanche"))}</span>`;
      if (s === "snowball") return `<span class="pill blue">${escapeHtml(t("strategy_snowball"))}</span>`;
      return `<span class="pill">${escapeHtml(s || "-")}</span>`;
    }

    function renderIntents() {
      const box = $("intentsList");
      if (!box) {
        renderStats();
        updateNextActionGuide();
        return;
      }
      box.innerHTML = "";

      if (!state.intents.length) {
        box.innerHTML = `<div class="empty">${escapeHtml(t("empty_intents"))}</div>`;
        renderStats();
        updateNextActionGuide();
        return;
      }

      state.intents.forEach((intent) => {
        const meta = normalizeIntentMetadata(intent.metadata);
        const isSpinIntent = String(intent.source || "").toLowerCase() === "spinwheel";
        const spinPill = isSpinIntent
          ? ` <span class="pill teal">${escapeHtml(t("intent_pill_spinwheel"))}</span>`
          : "";
        const item = document.createElement("div");
        item.className = "item";
        const actionsHtml = isSpinIntent
          ? `<div class="item-actions">
            <button class="btn btn-success btn-small" type="button" onclick="approveIntent('${intent.id}')">${escapeHtml(t("btn_approve"))}</button>
            <span class="muted" style="align-self:center;font-size:13px;">${escapeHtml(t("intent_spinwheel_coming_soon"))}</span>
          </div>`
          : `<div class="item-actions">
            <button class="btn btn-success btn-small" type="button" onclick="approveIntent('${intent.id}')">${escapeHtml(t("btn_approve"))}</button>
            <button class="btn btn-primary btn-small" type="button" onclick="executeIntent('${intent.id}')">${escapeHtml(t("btn_execute"))}</button>
          </div>`;
        item.innerHTML = `
          <div class="item-top">
            <div>
              <div class="item-title">${escapeHtml(t("intent_title"))} ${escapeHtml((intent.id || "").slice(0, 8))}${spinPill}</div>
              <div class="item-meta">
                ${escapeHtml(t("meta_pay_from"))}: <strong>${escapeHtml(describeIntentPayFrom(intent))}</strong><br />
                ${escapeHtml(t("meta_pay_toward"))}: <strong>${escapeHtml(describeIntentPayToward(intent))}</strong><br />
                ${escapeHtml(t("meta_debt"))}: <strong>${escapeHtml(intent.debt_id || "-")}</strong><br />
                ${escapeHtml(t("meta_total"))}: <strong>${fmtMoney(intentPaymentAmount(intent))}</strong><br />
                ${formatIntentReasonHtml(intent)}
                ${escapeHtml(t("meta_created"))}: <strong>${fmtDate(intent.created_at)}</strong><br />
                ${escapeHtml(t("meta_approved"))}: <strong>${fmtDate(intent.approved_at)}</strong><br />
                ${escapeHtml(t("meta_executed"))}: <strong>${fmtDate(intent.executed_at)}</strong>
              </div>
              ${
                meta.debt_balance_applied_at
                  ? `<div class="tag-row">
                      <span class="pill green">${escapeHtml(t("balance_applied"))}</span>
                      <span class="pill">${escapeHtml(t("prev_balance"))} ${fmtMoney(meta.debt_balance_previous)}</span>
                      <span class="pill">${escapeHtml(t("new_balance"))} ${fmtMoney(meta.debt_balance_next)}</span>
                    </div>`
                  : ""
              }
            </div>
            <div class="right">
              ${statusPill(intent.status)}
            </div>
          </div>
          ${actionsHtml}
        `;
        box.appendChild(item);
      });

      renderStats();
      updateNextActionGuide();
    }

    function renderTrace() {
      const box = $("traceList");
      box.innerHTML = "";

      if (!state.trace.length) {
        box.innerHTML = `<div class="empty">${escapeHtml(t("empty_trace"))}</div>`;
        return;
      }

      state.trace.slice(0, 30).forEach((row) => {
        const meta = row.metadata || {};
        const item = document.createElement("div");
        item.className = "item";
        item.innerHTML = `
          <div class="item-top">
            <div>
              <div class="item-title">${escapeHtml((row.id || "").slice(0, 8))} ? ${escapeHtml(row.status || "-")}</div>
              <div class="item-meta">
                ${escapeHtml(t("meta_debt"))}: <strong>${escapeHtml(row.debt_id || "-")}</strong><br />
                ${escapeHtml(t("meta_amount"))}: <strong>${fmtMoney(row.total_amount ?? row.amount ?? 0)}</strong><br />
                ${escapeHtml(t("meta_created"))}: <strong>${fmtDate(row.created_at)}</strong><br />
                ${escapeHtml(t("meta_executed"))}: <strong>${fmtDate(row.executed_at)}</strong>
              </div>
            </div>
            <div class="right">
              ${meta.debt_balance_applied_at ? `<span class="pill green">${escapeHtml(t("applied_tag"))}</span>` : statusPill(row.status)}
            </div>
          </div>
        `;
        box.appendChild(item);
      });
    }

    function categorizePlaidAccounts(rows) {
      const dep = [];
      const liab = [];
      const oth = [];
      for (const acc of rows) {
        const ty = String(acc.type || "").toLowerCase();
        if (ty === "depository") dep.push(acc);
        else if (ty === "credit" || ty === "loan") liab.push(acc);
        else oth.push(acc);
      }
      return { dep, liab, oth };
    }

    function plaidAccountKindLabel(acc) {
      const ty = String(acc.type || "").toLowerCase();
      const st = String(acc.subtype || "").toLowerCase();
      if (ty === "depository") {
        if (st === "checking") return t("kind_checking");
        if (st === "savings") return t("kind_savings");
        if (st === "cd") return t("kind_cd");
        if (st === "money market") return t("kind_mma");
        return t("kind_cash_other");
      }
      if (ty === "credit") {
        if (st === "credit card" || st === "paypal") return t("kind_credit_card");
        return t("kind_credit_line");
      }
      if (ty === "loan") {
        if (st === "mortgage") return t("kind_mortgage");
        if (st === "auto") return t("kind_auto_loan");
        if (st === "student") return t("kind_student_loan");
        if (st === "line of credit") return t("kind_loc_loan");
        return t("kind_loan_other");
      }
      if (ty === "investment") return t("kind_investment");
      if (ty === "brokerage") return t("kind_brokerage");
      if (ty === "other") return t("kind_other");
      return "";
    }

    function plaidConnectionItemId(row) {
      if (!row || typeof row !== "object") return "";
      return String(
        row.plaid_item_id ||
          row.item_id ||
          row.plaidItemId ||
          row.itemId ||
          row.connection_item_id ||
          row.plaid_connection_id ||
          ""
      ).trim();
    }

    function normalizePlaidConnectionRoleClient(v) {
      const s = String(v || "")
        .trim()
        .toLowerCase();
      if (s === "funding" || s === "pay_from" || s === "origin" || s === "origen") return "funding";
      if (
        s === "liabilities" ||
        s === "debts" ||
        s === "paydown" ||
        s === "destino" ||
        s === "deudas"
      ) {
        return "liabilities";
      }
      if (s === "both" || s === "ambos") return "both";
      return "unspecified";
    }

    function inferPlaidRoleFromAccountsOnly(itemId) {
      const accs = (state.accounts || []).filter((a) => plaidConnectionItemId(a) === itemId);
      if (!accs.length) return "unspecified";
      let hasDebt = false;
      let hasCash = false;
      accs.forEach((a) => {
        const ty = String(a.type || "").toLowerCase();
        if (ty === "credit" || ty === "loan") hasDebt = true;
        else hasCash = true;
      });
      if (hasDebt && hasCash) return "both";
      if (hasDebt) return "liabilities";
      return "funding";
    }

    function getPlaidItemRoleForItemId(itemId) {
      const it = (state.plaidItems || []).find((x) => plaidConnectionItemId(x) === itemId);
      const fromItem = it ? normalizePlaidConnectionRoleClient(it.connection_role) : "unspecified";
      if (fromItem !== "unspecified") return fromItem;
      return inferPlaidRoleFromAccountsOnly(itemId);
    }

    function entryMatchesFundingBankStrip(role) {
      return role === "funding" || role === "both" || role === "unspecified";
    }

    function entryMatchesLiabilitiesBankStrip(role) {
      return role === "liabilities" || role === "both";
    }

    function collectSyncedPlaidEntriesForSide(side) {
      return collectSyncedPlaidEntries().filter((e) => {
        const role = getPlaidItemRoleForItemId(e.plaid_item_id);
        if (side === "funding") return entryMatchesFundingBankStrip(role);
        return entryMatchesLiabilitiesBankStrip(role);
      });
    }

    function getSyncedInstitutionNameMap() {
      const map = new Map();
      (state.plaidItems || []).forEach((it) => {
        const itemId = plaidConnectionItemId(it);
        if (!itemId) return;
        const name = String(it?.institution_name || "").trim();
        map.set(itemId, name || t("sync_bank_default"));
      });
      return map;
    }

    function collectSyncedPlaidEntries() {
      const entries = [];
      const seen = new Set();
      const byItem = getSyncedInstitutionNameMap();

      (state.plaidItems || []).forEach((it) => {
        const itemId = plaidConnectionItemId(it);
        if (!itemId || seen.has(itemId)) return;
        seen.add(itemId);
        const name =
          String(it?.institution_name || "").trim() || t("sync_bank_default");
        const logo =
          typeof it?.institution_logo_data_url === "string" &&
          it.institution_logo_data_url.startsWith("data:image/")
            ? it.institution_logo_data_url
            : null;
        entries.push({ name, logo, plaid_item_id: itemId });
      });

      (state.accounts || []).forEach((acc) => {
        const itemId = plaidConnectionItemId(acc);
        if (!itemId || seen.has(itemId)) return;
        seen.add(itemId);
        entries.push({
          name: byItem.get(itemId) || t("sync_bank_default"),
          logo: null,
          plaid_item_id: itemId
        });
      });

      return entries;
    }

    function mergePlaidItemFromExchangeIfMissing(exchItem) {
      if (!exchItem || typeof exchItem !== "object") return;
      const id = plaidConnectionItemId(exchItem);
      if (!id) return;
      const already = collectSyncedPlaidEntries().some(
        (e) => String(e.plaid_item_id).trim() === id
      );
      if (already) return;
      const row = {
        plaid_item_id: id,
        institution_id: exchItem.institution_id || null,
        institution_name: exchItem.institution_name || null,
        institution_logo_data_url: null,
        connection_role: normalizePlaidConnectionRoleClient(exchItem.connection_role)
      };
      state.plaidItems = [...(Array.isArray(state.plaidItems) ? state.plaidItems : []), row];
      renderSyncedBanksStrip();
      updateDisconnectBankButton();
    }

    function updateDisconnectBankButton() {
      const n = collectSyncedPlaidEntries().length;
      const hint = n === 0 ? t("sync_bank_pick_none") : "";
      ["btnDisconnectBank", "accountsDisconnectBankBtn"].forEach((id) => {
        const btn = $(id);
        if (!btn) return;
        btn.disabled = false;
        btn.removeAttribute("aria-disabled");
        btn.title = hint;
        btn.classList.toggle("is-low-banks", n === 0);
      });
      const dfab = $("debtyaDisconnectFab");
      if (dfab) {
        dfab.title = hint;
        dfab.classList.toggle("is-low-banks", n === 0);
      }
    }

    function mountFallbackDisconnectFabIfMissing() {
      try {
        if (!appView || appView.classList.contains("hidden")) return;
        const stored = getStoredAccessToken();
        if (!state.session && !stored) return;
        if ($("btnDisconnectBank") || $("accountsDisconnectBankBtn")) return;
        if ($("debtyaDisconnectFab")) return;
        const fab = document.createElement("button");
        fab.id = "debtyaDisconnectFab";
        fab.type = "button";
        fab.className = "btn btn-light";
        fab.textContent = t("btn_disconnect_bank");
        fab.setAttribute("aria-label", t("btn_disconnect_bank"));
        fab.style.cssText =
          "position:fixed;right:16px;bottom:100px;z-index:9998;padding:10px 14px;border-radius:12px;font-weight:700;cursor:pointer;border:1px solid rgba(15,23,42,0.14);background:#fff;box-shadow:0 10px 30px rgba(15,23,42,0.14);max-width:min(220px,calc(100vw - 32px));";
        fab.addEventListener("click", () => {
          void openBankPickDisconnectFlow();
        });
        document.body.appendChild(fab);
        updateDisconnectBankButton();
      } catch (_) {}
    }

    function renderSyncedBanksStrip() {
      const fundingEntries = collectSyncedPlaidEntriesForSide("funding");
      const liabilitiesEntries = collectSyncedPlaidEntriesForSide("liabilities");

      const fill = (wrap, strip, entries) => {
        if (!wrap || !strip) return;
        if (!entries.length) {
          wrap.classList.add("hidden");
          strip.replaceChildren();
          return;
        }
        strip.replaceChildren();
        entries.forEach(({ name, logo, plaid_item_id: itemId }) => {
          const pill = document.createElement("span");
          pill.className = "sync-bank-pill";
          const inner = document.createElement("span");
          inner.className = "sync-bank-pill-inner";
          if (logo) {
            const img = document.createElement("img");
            img.className = "sync-bank-icon-img";
            img.src = logo;
            img.alt = name;
            img.loading = "lazy";
            inner.appendChild(img);
          } else {
            const initial = (String(name).trim()[0] || "B").toUpperCase();
            const ic = document.createElement("span");
            ic.className = "sync-bank-icon";
            ic.textContent = initial;
            inner.appendChild(ic);
          }
          const label = document.createElement("span");
          label.textContent = name;
          inner.appendChild(label);
          pill.appendChild(inner);
          strip.appendChild(pill);
        });
        wrap.classList.remove("hidden");
      };

      fill($("operateFundingBanksWrap"), $("operateFundingBanksStrip"), fundingEntries);
      fill($("operateLiabilitiesBanksWrap"), $("operateLiabilitiesBanksStrip"), liabilitiesEntries);
      fill($("accountsFundingBanksWrap"), $("accountsFundingBanksStrip"), fundingEntries);
      fill($("accountsLiabilitiesBanksWrap"), $("accountsLiabilitiesBanksStrip"), liabilitiesEntries);
      updateDisconnectBankButton();
    }

    function updatePlanFieldHints() {
      const stratEl = $("planStrategy");
      const modeEl = $("planMode");
      const sh = $("planStrategyHint");
      const mh = $("planModeHint");
      if (!stratEl || !sh) return;
      const strat = stratEl.value === "snowball" ? "snowball" : "avalanche";
      sh.textContent = t(strat === "snowball" ? "hint_strategy_snowball" : "hint_strategy_avalanche");
      if (modeEl && mh) {
        const m = modeEl.value;
        const modeKey =
          m === "safe_auto"
            ? "hint_mode_safe_auto"
            : m === "full_auto"
              ? "hint_mode_full_auto"
              : "hint_mode_manual";
        mh.textContent = t(modeKey);
      }
    }

    function renderAccountCardHTML(acc) {
      const current = acc.current_balance ?? acc.balance_current ?? 0;
      const available = acc.available_balance ?? acc.balance_available ?? 0;
      const limitRaw = acc.limit_balance ?? acc.limit ?? null;
      const limitNum = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : null;
      const tyLower = String(acc.type || "").toLowerCase();
      const kind = plaidAccountKindLabel(acc);
      const kindLine = kind
        ? `<div class="acct-kind-hint">${escapeHtml(kind)}</div>`
        : "";
      const limitLine =
        limitNum != null &&
        !Number.isNaN(limitNum) &&
        limitNum > 0 &&
        tyLower === "credit"
          ? `<div class="muted" style="font-size:12px;margin-top:4px;">${escapeHtml(t("acct_credit_limit"))}: ${fmtMoney(limitNum)}</div>`
          : "";
      return `
        <div class="item">
          <div class="item-top">
            <div>
              <div class="item-title">${escapeHtml(acc.name || t("acct_default"))} ${acc.mask ? `? ****${escapeHtml(acc.mask)}` : ""}</div>
              ${kindLine}
              <div class="item-meta">
                ${escapeHtml(t("acct_type"))}: <strong>${escapeHtml(acc.type || "-")}</strong> ?
                ${escapeHtml(t("acct_subtype"))}: <strong>${escapeHtml(acc.subtype || "-")}</strong>
              </div>
            </div>
            <div class="right">
              <div class="money">${fmtMoney(current)}</div>
              <div class="muted" style="font-size:12px;margin-top:4px;">${escapeHtml(t("available_lbl"))}: ${fmtMoney(available)}</div>
              ${limitLine}
            </div>
          </div>
        </div>
      `;
    }

    function renderAccountSection(titleClass, titleKey, accounts) {
      let html = `<div class="acct-section"><h3 class="acct-section-title ${titleClass}">${escapeHtml(t(titleKey))}</h3>`;
      if (!accounts.length) {
        html += `<div class="empty">${escapeHtml(t("accounts_empty_section"))}</div>`;
      } else {
        html += accounts.map((acc) => renderAccountCardHTML(acc)).join("");
      }
      html += `</div>`;
      return html;
    }

    function renderAccounts() {
      const box = $("accountsList");
      box.innerHTML = "";

      if (!state.accounts.length) {
        box.innerHTML = `<div class="empty">${escapeHtml(t("empty_accounts"))}</div>`;
        renderSyncedBanksStrip();
        populateDebtFormLinkedSelect();
        populateDebtFromAccountSelect();
        populatePlanRoutingSelects();
        updateNextActionGuide();
        return;
      }

      const { dep, liab, oth } = categorizePlaidAccounts(state.accounts);
      box.innerHTML = `
        <div class="accounts-split">
          ${renderAccountSection("cash", "accounts_sec_cash", dep)}
          ${renderAccountSection("debt", "accounts_sec_debt", liab)}
          ${renderAccountSection("other", "accounts_sec_other", oth)}
        </div>
      `;
      renderSyncedBanksStrip();
      populateDebtFormLinkedSelect();
      populateDebtFromAccountSelect();
      populatePlanRoutingSelects();
      updateNextActionGuide();
    }

    function accountLabelPlain(acc) {
      if (!acc) return "";
      const mask = acc.mask ? ` ? ****${acc.mask}` : "";
      return `${acc.name || t("acct_default")}${mask}`;
    }

    function describeIntentPayFrom(intent) {
      const pid = String(intent.source_account_id || "").trim();
      if (!pid) return t("intent_pay_from_unknown");
      const acc = (state.accounts || []).find((a) => String(a.plaid_account_id) === pid);
      if (acc) return accountLabelPlain(acc);
      return pid.length > 10 ? `${pid.slice(0, 8)}?` : pid;
    }

    function describeIntentPayToward(intent) {
      if (!intent) return t("dashboard_debt_fallback");
      const did = String(intent.debt_id || "").trim();
      if (did) {
        const d = (state.debts || []).find((x) => String(x.id) === did);
        if (d) {
          const nm = d.name != null ? String(d.name).trim() : "";
          if (nm) return nm;
        }
      }
      const flat = intent.creditor_name || intent.debt_name || intent.name || "";
      if (flat && String(flat).trim()) return String(flat).trim();
      const meta = normalizeIntentMetadata(intent.metadata);
      const fromMeta =
        meta.creditor_name ||
        meta.debt_name ||
        meta.name ||
        meta.debtName ||
        "";
      if (fromMeta && String(fromMeta).trim()) return String(fromMeta).trim();
      return t("dashboard_debt_fallback");
    }

    function populatePlanRoutingSelects() {
      const fundSel = $("planFundingAccount");
      const debtSel = $("planPaydownDebt");
      if (!fundSel || !debtSel) return;

      const savedFund = String(state.plan?.funding_plaid_account_id || "").trim();
      const savedDebt = String(state.plan?.payment_target_debt_id || "").trim();

      fundSel.innerHTML = "";
      const fe = document.createElement("option");
      fe.value = "";
      fe.textContent = t("plan_pay_from_none");
      fundSel.appendChild(fe);
      (state.accounts || []).forEach((acc) => {
        if (String(acc.type || "").toLowerCase() !== "depository") return;
        const id = String(acc.plaid_account_id || "").trim();
        if (!id) return;
        const op = document.createElement("option");
        op.value = id;
        op.textContent = accountLabelPlain(acc);
        fundSel.appendChild(op);
      });

      debtSel.innerHTML = "";
      const de = document.createElement("option");
      de.value = "";
      de.textContent = t("plan_pay_toward_none");
      debtSel.appendChild(de);
      (state.debts || []).forEach((d) => {
        if (!d?.id) return;
        const op = document.createElement("option");
        op.value = d.id;
        op.textContent = `${d.name || t("debt_label")} ? ${fmtMoney(d.balance)}`;
        debtSel.appendChild(op);
      });

      fundSel.value = savedFund;
      debtSel.value = savedDebt;
      if (savedFund && ![...fundSel.options].some((o) => o.value === savedFund)) fundSel.value = "";
      if (savedDebt && ![...debtSel.options].some((o) => o.value === savedDebt)) debtSel.value = "";
    }

    function renderPlan() {
      const plan = state.plan || {};
      $("planStrategy").value = plan.strategy || "avalanche";
      $("planMode").value = plan.automation_mode || plan.auto_mode || "manual";
      $("planMonthlyBudget").value = plan.monthly_budget_default ?? plan.monthly_budget ?? "";
      $("planExtraPayment").value = plan.extra_payment_default ?? "";

      populatePlanRoutingSelects();

      updateNextActionGuide();
      updatePlanFieldHints();
    }

    function renderUser() {
      $("welcomeText").textContent = state.user?.email
        ? `${t("welcome_hello")}, ${state.user.email}`
        : t("app_welcome_default");
    }

    function renderBilling() {
      const billing = state.billing || {
        status: "inactive",
        active: false,
        current_period_end: null,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        cancel_at_period_end: false,
        promo_codes_configured: null
      };

      const billingStatusText = $("billingStatusText");
      const billingActiveText = $("billingActiveText");
      const billingPeriodText = $("billingPeriodText");
      if (billingStatusText) billingStatusText.textContent = translateBillingStatus(billing.status || "inactive");
      if (billingActiveText) billingActiveText.textContent = billing.active ? t("yes") : t("no");
      if (billingPeriodText) billingPeriodText.textContent = billing.current_period_end ? fmtDate(billing.current_period_end) : "-";

      if (billing.active) {
        $("sessionBadge").className = "pill green";
        $("sessionBadge").textContent = billing.cancel_at_period_end ? t("badge_sub_until_end") : t("badge_sub_active");
      } else {
        $("sessionBadge").className = "pill blue";
        $("sessionBadge").textContent = t("badge_session");
      }

      const canManage = !!billing.stripe_customer_id;
      const isActive = !!billing.active;

      const billingManageBtn = $("billingManageBtn");
      const topManageBillingBtn = $("topManageBillingBtn");
      const billingStartBtn = $("billingStartBtn");
      const topUpgradeBtn = $("topUpgradeBtn");
      if (billingManageBtn) billingManageBtn.classList.toggle("hidden", !canManage);
      if (topManageBillingBtn) topManageBillingBtn.classList.toggle("hidden", !canManage);
      if (billingStartBtn) billingStartBtn.classList.toggle("hidden", isActive);
      if (topUpgradeBtn) topUpgradeBtn.classList.toggle("hidden", isActive);

      const promoWrap = $("promoCompWrap");
      if (promoWrap) promoWrap.classList.toggle("hidden", isActive);

      const promoHint = $("promoCompServerHint");
      if (promoHint) {
        if (!isActive && billing.promo_codes_configured === false) {
          promoHint.textContent = t("promo_comp_server_off");
          promoHint.classList.remove("hidden");
        } else {
          promoHint.classList.add("hidden");
        }
      }
    }

    function renderCompare(data) {
      const box = $("compareResult");
      box.innerHTML = "";

      if (!data?.avalanche || !data?.snowball) {
        box.innerHTML = `<div class="empty">${escapeHtml(t("empty_compare"))}</div>`;
        return;
      }

      const av = data.avalanche;
      const sn = data.snowball;

      box.innerHTML = `
        <div class="item">
          <div class="item-top">
            <div>
              <div class="item-title">${escapeHtml(t("strategy_avalanche"))}</div>
              <div class="item-meta">
                ${escapeHtml(t("months_lbl"))}: <strong>${av.months_to_payoff}</strong><br />
                ${escapeHtml(t("interest_total_lbl"))}: <strong>${fmtMoney(av.total_interest)}</strong><br />
                ${escapeHtml(t("total_paid_lbl"))}: <strong>${fmtMoney(av.total_paid)}</strong>
              </div>
            </div>
            <div>${statusPill("avalanche")}</div>
          </div>
        </div>
        <div class="item">
          <div class="item-top">
            <div>
              <div class="item-title">${escapeHtml(t("strategy_snowball"))}</div>
              <div class="item-meta">
                ${escapeHtml(t("months_lbl"))}: <strong>${sn.months_to_payoff}</strong><br />
                ${escapeHtml(t("interest_total_lbl"))}: <strong>${fmtMoney(sn.total_interest)}</strong><br />
                ${escapeHtml(t("total_paid_lbl"))}: <strong>${fmtMoney(sn.total_paid)}</strong>
              </div>
            </div>
            <div>${statusPill("snowball")}</div>
          </div>
        </div>
      `;
    }

    async function refreshDebts() {
      const res = await api("/debts");
      state.debts = res.data || [];
      renderDebts();
    }

    function isSpinwheelMeNoMappingError(err) {
      const msg = String(err && err.message ? err.message : "").toLowerCase();
      return (
        msg.includes("spinwheel_mapping_not_found") ||
        msg.includes("sin v\u00ednculo spinwheel") ||
        msg.includes("sin vinculo spinwheel") ||
        /\b404\b/.test(msg)
      );
    }

    function isSpinwheelUserAlreadyConnectedMessage(msg) {
      const m = String(msg || "").toLowerCase();
      return (
        m.includes("user already connected") ||
        m.includes("already connected") ||
        m.includes("usuario ya conectado") ||
        m.includes("useralreadyconnected")
      );
    }

    function spinwheelBodySaysUserAlreadyConnected(sw, seen, depth) {
      const s = seen instanceof Set ? seen : new Set();
      const d = typeof depth === "number" ? depth : 0;
      if (!sw || d > 14) return false;
      if (typeof sw === "string") {
        return /user already connected|already connected|usuario ya conectado/i.test(sw);
      }
      if (typeof sw !== "object") return false;
      if (s.has(sw)) return false;
      s.add(sw);
      if (Array.isArray(sw)) {
        for (const x of sw) {
          if (spinwheelBodySaysUserAlreadyConnected(x, s, d + 1)) return true;
        }
        return false;
      }
      for (const v of Object.values(sw)) {
        if (spinwheelBodySaysUserAlreadyConnected(v, s, d + 1)) return true;
      }
      return false;
    }

    function spinwheelConnectionStatusFromApiPayload(payload) {
      const sw =
        payload && payload.spinwheel && typeof payload.spinwheel === "object" ? payload.spinwheel : null;
      if (!sw) return "";
      const d = sw.data && typeof sw.data === "object" ? sw.data : {};
      let cs = d.connectionStatus != null ? String(d.connectionStatus).trim().toUpperCase() : "";
      if (!cs && sw.connectionStatus != null) cs = String(sw.connectionStatus).trim().toUpperCase();
      return cs || "";
    }

    function friendlyDebtConnectError(err) {
      const raw = err && err.message != null ? String(err.message) : String(err || "");
      if (/spinwheel not configured|spinwheel_not_configured|Spinwheel no configurado/i.test(raw)) {
        return t("sw_connect_unavailable");
      }
      if (/Timeout en \/spinwheel/i.test(raw) || raw.includes("Timeout en")) return t("err_timeout");
      let s = normalizeErrorMessage(raw);
      s = s.replace(/\brequest[_-]?id\s*[:=]\s*[^\s]+/gi, "").trim();
      s = s.replace(/\brequest_id\b[^.!?]*[.!?]?/gi, "").trim();
      s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "").replace(/\s{2,}/g, " ").trim();
      if (/^[\{\[]/.test(s) || /^\s*["']?\s*\{/.test(s)) return t("sw_connect_err_generic");
      if (s.length > 240) return `${s.slice(0, 237)}...`;
      return s || t("sw_connect_err_generic");
    }

    function swConnectShowErr(msg) {
      const errEl = $("swConnectFlowErr");
      const okEl = $("swConnectFlowMsg");
      if (okEl) {
        okEl.classList.add("hidden");
        okEl.textContent = "";
      }
      if (!errEl) return;
      if (!msg) {
        errEl.textContent = "";
        errEl.classList.add("hidden");
        return;
      }
      errEl.textContent = msg;
      errEl.classList.remove("hidden");
    }

    function swConnectShowOk(msg) {
      const okEl = $("swConnectFlowMsg");
      const errEl = $("swConnectFlowErr");
      if (errEl) {
        errEl.textContent = "";
        errEl.classList.add("hidden");
      }
      if (!okEl) return;
      okEl.textContent = msg;
      okEl.classList.remove("hidden");
    }

    function normalizePhoneForSpinwheel(raw) {
      const p = String(raw || "").trim();
      if (!p) return "";
      if (p.startsWith("+")) return p;
      const digits = p.replace(/\D/g, "");
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      if (digits.length > 0) return `+${digits}`;
      return p;
    }

    async function runSpinwheelDebtProfileAndImport() {
      await api("/spinwheel/users/me/debt-profile", {
        method: "POST",
        body: JSON.stringify({ creditReport: { type: "1_BUREAU.FULL" } })
      });
      await api("/spinwheel/import-debts", { method: "POST", body: "{}" });
    }

    /**
     * @param {"sw_connect_success"|"sw_connect_already_synced"} i18nKey
     */
    async function swConnectCompleteDebtProfileFlow(i18nKey) {
      swConnectShowErr("");
      await runSpinwheelDebtProfileAndImport();
      swConnectClearSensitiveFields();
      const vb = $("swConnectVerifyBlock");
      if (vb) vb.classList.add("hidden");
      swConnectShowOk(t(i18nKey));
      await refreshDebts();
    }

    function swConnectClearSensitiveFields() {
      const p = $("swConnectPhone");
      const d = $("swConnectDob");
      const c = $("swConnectSmsCode");
      if (p) p.value = "";
      if (d) d.value = "";
      if (c) c.value = "";
    }

    async function onSwConnectSearchClick() {
      swConnectShowErr("");
      const okEl = $("swConnectFlowMsg");
      if (okEl) {
        okEl.classList.add("hidden");
        okEl.textContent = "";
      }
      const btn = $("swConnectSearchBtn");
      const vb0 = $("swConnectVerifyBlock");
      if (vb0) vb0.classList.add("hidden");
      setLoading(btn, true);
      try {
        let me = null;
        try {
          me = await api("/spinwheel/me");
        } catch (e) {
          if (!isSpinwheelMeNoMappingError(e)) throw e;
          me = null;
        }
        if (me && me.ok && me.mapping && String(me.mapping.spinwheel_user_id || "").trim()) {
          await swConnectCompleteDebtProfileFlow("sw_connect_already_synced");
          return;
        }

        const phoneEl = $("swConnectPhone");
        const dobEl = $("swConnectDob");
        const phoneRaw = phoneEl ? String(phoneEl.value || "").trim() : "";
        const dob = dobEl ? String(dobEl.value || "").trim() : "";
        if (!phoneRaw) {
          swConnectShowErr(t("sw_connect_err_phone"));
          return;
        }
        if (!dob) {
          swConnectShowErr(t("sw_connect_err_dob"));
          return;
        }
        const phoneNumber = normalizePhoneForSpinwheel(phoneRaw);
        const digitCount = phoneNumber.replace(/\D/g, "").length;
        if (digitCount < 10) {
          swConnectShowErr(t("sw_connect_err_phone_invalid"));
          return;
        }

        const res = await api("/spinwheel/connect/sms", {
          method: "POST",
          body: JSON.stringify({ phoneNumber, dateOfBirth: dob })
        });
        if (spinwheelBodySaysUserAlreadyConnected(res.spinwheel)) {
          await swConnectCompleteDebtProfileFlow("sw_connect_already_synced");
          return;
        }
        const cs = spinwheelConnectionStatusFromApiPayload(res);
        if (cs === "IN_PROGRESS") {
          const vb = $("swConnectVerifyBlock");
          if (vb) vb.classList.remove("hidden");
          const codeIn = $("swConnectSmsCode");
          if (codeIn) {
            codeIn.value = "";
            codeIn.focus();
          }
          return;
        }
        if (cs === "SUCCESS") {
          await swConnectCompleteDebtProfileFlow("sw_connect_success");
          return;
        }
        swConnectShowErr(t("sw_connect_err_unexpected_link"));
      } catch (e) {
        const raw = e && e.message != null ? String(e.message) : "";
        if (isSpinwheelUserAlreadyConnectedMessage(raw)) {
          try {
            await swConnectCompleteDebtProfileFlow("sw_connect_already_synced");
          } catch (e2) {
            swConnectShowErr(friendlyDebtConnectError(e2));
          }
        } else {
          swConnectShowErr(friendlyDebtConnectError(e));
        }
      } finally {
        setLoading(btn, false);
      }
    }

    async function onSwConnectVerifyClick() {
      const codeIn = $("swConnectSmsCode");
      const code = codeIn ? String(codeIn.value || "").trim() : "";
      swConnectShowErr("");
      const okEl = $("swConnectFlowMsg");
      if (okEl) {
        okEl.classList.add("hidden");
        okEl.textContent = "";
      }
      if (!code) {
        swConnectShowErr(t("sw_connect_err_code"));
        return;
      }
      const btn = $("swConnectVerifyBtn");
      setLoading(btn, true);
      try {
        const res = await api("/spinwheel/users/me/connect/sms/verify", {
          method: "POST",
          body: JSON.stringify({ code })
        });
        const cs = spinwheelConnectionStatusFromApiPayload(res);
        if (cs === "SUCCESS") {
          if (codeIn) codeIn.value = "";
          await swConnectCompleteDebtProfileFlow("sw_connect_success");
          return;
        }
        swConnectShowErr(t("sw_connect_err_verify"));
      } catch (e) {
        const raw = e && e.message != null ? String(e.message) : "";
        if (isSpinwheelUserAlreadyConnectedMessage(raw)) {
          try {
            await swConnectCompleteDebtProfileFlow("sw_connect_already_synced");
          } catch (e2) {
            swConnectShowErr(friendlyDebtConnectError(e2));
          }
        } else {
          swConnectShowErr(friendlyDebtConnectError(e));
        }
      } finally {
        setLoading(btn, false);
      }
    }

    function spinwheelPayableDiagEnabled() {
      try {
        if (typeof window === "undefined") return false;
        const h = String(window.location.hash || "").toLowerCase();
        if (h === "#spinwheel-payable-diag") return true;
        const qs = new URLSearchParams(window.location.search || "");
        if (qs.get("swdiag") === "1") return true;
        if (window.localStorage && window.localStorage.getItem("DEBTYA_SPINWHEEL_PAY_DIAG") === "1") return true;
      } catch (_) {}
      return false;
    }

    function renderSpinwheelPayableDiagBody(payload) {
      const j = payload && typeof payload === "object" ? payload : {};
      const parts = [];
      parts.push('<div class="spinwheel-diag-stats">');
      parts.push(
        `<div><span class="k">${escapeHtml(t("spinwheel_diag_total"))}</span> <strong>${escapeHtml(String(j.total_spinwheel_debts ?? 0))}</strong></div>`
      );
      parts.push(
        `<div><span class="k">${escapeHtml(t("spinwheel_diag_payable"))}</span> <strong>${escapeHtml(String(j.payable_count ?? 0))}</strong></div>`
      );
      parts.push(
        `<div><span class="k">${escapeHtml(t("spinwheel_diag_planning"))}</span> <strong>${escapeHtml(String(j.planning_only_count ?? 0))}</strong></div>`
      );
      parts.push(
        `<div><span class="k">${escapeHtml(t("spinwheel_diag_field"))}</span> <strong>${escapeHtml(String(j.field_error_count ?? 0))}</strong></div>`
      );
      parts.push(
        `<div><span class="k">${escapeHtml(t("spinwheel_diag_not_sup"))}</span> <strong>${escapeHtml(String(j.not_supported_count ?? 0))}</strong></div>`
      );
      parts.push("</div>");

      const payable = Array.isArray(j.payable_debts) ? j.payable_debts : [];
      if (payable.length) {
        parts.push(`<h4 class="spinwheel-diag-subh">${escapeHtml(t("spinwheel_diag_payable_list"))}</h4>`);
        parts.push('<ul class="spinwheel-diag-list">');
        for (const p of payable) {
          parts.push(
            `<li>${escapeHtml(String(p.name || ""))} \u2014 ${escapeHtml(fmtMoney(p.balance))} <span class="muted">(${escapeHtml(String(p.spinwheel_external_id || "").slice(0, 8))}\u2026)</span></li>`
          );
        }
        parts.push("</ul>");
      }

      const blocked = Array.isArray(j.blocked_debts) ? j.blocked_debts : [];
      if (blocked.length) {
        parts.push(`<h4 class="spinwheel-diag-subh">${escapeHtml(t("spinwheel_diag_blocked"))}</h4>`);
        parts.push('<ul class="spinwheel-diag-list">');
        for (const b of blocked) {
          parts.push(
            `<li><strong>${escapeHtml(String(b.name || ""))}</strong> \u2014 ${escapeHtml(fmtMoney(b.balance))} <span class="muted">${escapeHtml(String(b.category || ""))}: ${escapeHtml(String(b.reason || ""))}</span></li>`
          );
        }
        parts.push("</ul>");
      }

      return parts.join("");
    }

    async function refreshSpinwheelPayableDiag() {
      const wrap = $("spinwheelPayableDiagSection");
      if (!wrap) return;
      if (!spinwheelPayableDiagEnabled()) {
        wrap.classList.add("hidden");
        return;
      }
      wrap.classList.remove("hidden");
      const body = $("spinwheelPayableDiagBody");
      const errEl = $("spinwheelPayableDiagError");
      if (body) body.innerHTML = `<p class="sub">${escapeHtml(t("spinwheel_diag_loading"))}</p>`;
      if (errEl) {
        errEl.textContent = "";
        errEl.classList.add("hidden");
      }
      try {
        const j = await api("/spinwheel/payable-debts-summary");
        if (body) body.innerHTML = renderSpinwheelPayableDiagBody(j);
      } catch (e) {
        if (body) body.innerHTML = "";
        if (errEl) {
          errEl.textContent = normalizeErrorMessage(e && e.message ? String(e.message) : String(e));
          errEl.classList.remove("hidden");
        }
      }
    }

    async function refreshRules() {
      const res = await api("/rules");
      state.rules = res.data || [];
      renderRules();
      updateNextActionGuide();
    }

    async function refreshPlan() {
      const res = await api("/payment-plan");
      state.plan = res.data || null;
      renderPlan();
    }

    async function refreshIntents() {
      const res = await api("/payment-intents");
      let list = res && res.data;
      if (!Array.isArray(list)) {
        if (Array.isArray(res?.intents)) list = res.intents;
        else if (res?.data != null && typeof res.data === "object" && Array.isArray(res.data.intents)) list = res.data.intents;
        else list = [];
      }
      state.intents = list;
      state.paymentIntents = list;
      const featuredIntent = pickFeaturedIntentForDashboard(list);
      console.log("[DebtYa payment intents loaded]", list);
      console.log("[DebtYa featured intent]", featuredIntent);
      renderIntents();
      updateNextActionGuide();
    }

    async function refreshTrace() {
      const res = await api("/payment-trace");
      state.trace = res.data || [];
      renderTrace();
    }

    async function refreshPlaidItems() {
      try {
        const res = await api("/plaid/items");
        let raw = res?.data;
        if (!Array.isArray(raw)) raw = Array.isArray(res?.items) ? res.items : [];
        if (!Array.isArray(raw) && Array.isArray(res)) raw = res;
        state.plaidItems = (Array.isArray(raw) ? raw : []).map((row) => {
          if (!row || typeof row !== "object") return row;
          const id = plaidConnectionItemId(row);
          return id
            ? {
                ...row,
                plaid_item_id: id,
                connection_role: normalizePlaidConnectionRoleClient(row.connection_role)
              }
            : row;
        });
      } catch {
        state.plaidItems = [];
      }
    }

    let bankDcPendingId = null;
    let bankDcPendingName = "";

    function closeBankPickModal() {
      const root = $("bankPickDisconnectModal");
      if (!root) return;
      root.classList.add("hidden");
      root.setAttribute("aria-hidden", "true");
    }

    let bankRoleChoiceResolver = null;

    function closeBankConnectionRoleModal() {
      const root = $("bankConnectionRoleModal");
      if (!root) return;
      root.classList.add("hidden");
      root.setAttribute("aria-hidden", "true");
    }

    function openBankConnectionRoleChoice() {
      return new Promise((resolve) => {
        bankRoleChoiceResolver = resolve;
        const root = $("bankConnectionRoleModal");
        if (!root) {
          bankRoleChoiceResolver = null;
          resolve("unspecified");
          return;
        }
        root.classList.remove("hidden");
        root.setAttribute("aria-hidden", "false");
      });
    }

    function finishBankConnectionRoleChoice(role) {
      const fn = bankRoleChoiceResolver;
      bankRoleChoiceResolver = null;
      closeBankConnectionRoleModal();
      if (typeof fn === "function") fn(role);
    }

    async function openBankPickDisconnectFlow() {
      try {
        await refreshAccounts();
      } catch (e) {
        showMessage(globalMessage, normalizeErrorMessage(e.message), "error");
        return;
      }
      updateDisconnectBankButton();
      const entries = collectSyncedPlaidEntries();
      if (!entries.length) {
        showMessage(globalMessage, t("sync_bank_pick_none"), "warn");
        return;
      }
      if (entries.length === 1) {
        openBankDisconnectModal(entries[0].plaid_item_id, entries[0].name);
        return;
      }
      const sel = $("bankPickSelect");
      if (!sel) return;
      sel.innerHTML = "";
      entries.forEach((e) => {
        const op = document.createElement("option");
        op.value = e.plaid_item_id;
        op.textContent = e.name;
        sel.appendChild(op);
      });
      const root = $("bankPickDisconnectModal");
      if (!root) return;
      root.classList.remove("hidden");
      root.setAttribute("aria-hidden", "false");
      window.setTimeout(() => sel.focus(), 30);
    }

    function confirmBankPickContinue() {
      const sel = $("bankPickSelect");
      if (!sel) {
        closeBankPickModal();
        return;
      }
      const id = String(sel.value || "").trim();
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      const name = opt ? String(opt.textContent || "").trim() : t("sync_bank_default");
      if (!id) {
        closeBankPickModal();
        return;
      }
      closeBankPickModal();
      openBankDisconnectModal(id, name);
    }

    function closeBankDisconnectModal() {
      bankDcPendingId = null;
      bankDcPendingName = "";
      const root = $("bankDisconnectModal");
      if (!root) return;
      root.classList.add("hidden");
      root.setAttribute("aria-hidden", "true");
    }

    function openBankDisconnectModal(plaidItemId, bankDisplayName) {
      const id = String(plaidItemId || "").trim();
      if (!id) return;
      const root = $("bankDisconnectModal");
      const titleEl = $("bankDcTitle");
      const bodyEl = $("bankDcBody");
      const cancelBtn = $("bankDcCancel");
      const confirmBtn = $("bankDcConfirm");
      if (!root || !titleEl || !bodyEl || !cancelBtn || !confirmBtn) return;

      bankDcPendingId = id;
      const bankLabel = String(bankDisplayName || "").trim() || t("sync_bank_default");
      bankDcPendingName = bankLabel;
      titleEl.textContent = t("sync_bank_modal_title");
      bodyEl.textContent = tf("sync_bank_modal_body", { bank: bankLabel });
      cancelBtn.textContent = t("sync_bank_modal_cancel");
      confirmBtn.textContent = t("sync_bank_modal_confirm");

      root.classList.remove("hidden");
      root.setAttribute("aria-hidden", "false");
      window.setTimeout(() => cancelBtn.focus(), 30);
    }

    async function confirmDisconnectPlaidBank() {
      const id = String(bankDcPendingId || "").trim();
      if (!id) {
        closeBankDisconnectModal();
        return;
      }
      const confirmBtn = $("bankDcConfirm");
      if (confirmBtn) confirmBtn.disabled = true;
      try {
        await api("/plaid/items/disconnect", {
          method: "POST",
          body: JSON.stringify({ plaid_item_id: id })
        });
        closeBankDisconnectModal();
        showMessage(globalMessage, t("sync_bank_disconnected_ok"), "success");
        await Promise.all([
          refreshAccounts(),
          refreshDebts(),
          refreshPlan(),
          refreshIntents()
        ]);
      } catch (e) {
        showMessage(globalMessage, normalizeErrorMessage(e.message), "error");
      } finally {
        if (confirmBtn) confirmBtn.disabled = false;
      }
    }

    async function refreshAccounts() {
      const [accountsRes] = await Promise.all([
        api("/accounts"),
        refreshPlaidItems()
      ]);
      state.accounts = accountsRes.data || [];
      if (state.accounts.length > 0) setBankExchangeFlag();
      renderAccounts();
    }

    function safeMethodDomId(id) {
      return String(id || "").replace(/[^a-zA-Z0-9_]/g, "_");
    }

    function methodDebtTitleFromRow(row) {
      try {
        const snap = row && row.raw_snapshot && typeof row.raw_snapshot === "object" ? row.raw_snapshot : {};
        const li = snap.liability || row.liability || {};
        const name = li && li.name ? String(li.name).trim() : "";
        const mask = li && li.mask ? String(li.mask).trim() : "";
        if (name) return name;
        if (mask) return `${t("debt_label")} ? ****${mask}`;
        return row.method_account_id || t("debt_label");
      } catch (_) {
        return row.method_account_id || t("debt_label");
      }
    }

    function updateMethodPanelHint() {
      const el = $("methodPanelHint");
      if (!el) return;
      if (!state.methodConfigured) {
        el.removeAttribute("data-i18n");
        el.textContent = t("method_panel_disabled");
        return;
      }
      el.setAttribute("data-i18n", "method_panel_hint");
      el.textContent = t("method_panel_hint");
    }

    function updateMethodEntityPickHint() {
      const el = $("methodEntityPickHint");
      if (!el) return;
      if (!state.methodConfigured) {
        el.textContent = "";
        el.classList.remove("error-text");
        return;
      }
      if (state.methodEntityCreating) {
        el.textContent = t("method_entity_hint_creating");
        el.classList.remove("error-text");
        return;
      }
      if (state.methodEntitiesLoadError) {
        el.textContent = state.methodEntitiesLoadError;
        el.classList.add("error-text");
        return;
      }
      el.classList.remove("error-text");
      const rows = Array.isArray(state.methodEntities) ? state.methodEntities : [];
      const n = rows.filter((r) => r && r.method_entity_id).length;
      if (!n) el.textContent = t("method_entity_hint_none");
      else el.textContent = t("method_entity_hint_count").replace(/\{\{n\}\}/g, String(n));
    }

    function populateMethodEntityPick() {
      const sel = $("methodEntityPick");
      if (!sel) return;
      const rows = Array.isArray(state.methodEntities) ? state.methodEntities : [];
      const prev = sel.value;
      let placeholder = "?";
      if (state.methodConfigured && !state.methodEntitiesLoadError && !state.methodEntityCreating) {
        const n = rows.filter((r) => r && r.method_entity_id).length;
        if (!n) placeholder = t("method_entity_pick_empty");
      }
      let html = `<option value="">${escapeHtml(placeholder)}</option>`;
      rows.forEach((r) => {
        const mid = r.method_entity_id || "";
        if (!mid) return;
        const label = `${mid}${r.status ? " ? " + String(r.status) : ""}`;
        html += `<option value="${escapeHtml(mid)}">${escapeHtml(label)}</option>`;
      });
      sel.innerHTML = html;
      if (prev && rows.some((r) => String(r.method_entity_id) === String(prev))) sel.value = prev;
      else if (rows[0] && rows[0].method_entity_id) sel.value = rows[0].method_entity_id;
      else sel.value = "";
      updateMethodEntityPickHint();
    }

    async function importMethodDebtToDebtya(methodAccountId) {
      try {
        const sid = safeMethodDomId(methodAccountId);
        const balEl = $(`methodBal_${sid}`);
        const aprEl = $(`methodApr_${sid}`);
        const minEl = $(`methodMin_${sid}`);
        const balance = balEl ? Number(balEl.value || 0) : 0;
        const apr = aprEl ? Number(aprEl.value || 0) : 0;
        const minimum_payment = minEl ? Number(minEl.value || 0) : 0;
        await api("/method/import-debt", {
          method: "POST",
          body: JSON.stringify({ method_account_id: methodAccountId, balance, apr, minimum_payment })
        });
        showMessage(globalMessage, t("method_import_ok"), "success");
        await Promise.all([refreshDebts(), refreshMethodSection()]);
      } catch (e) {
        showMessage(globalMessage, normalizeErrorMessage(e.message), "error");
      }
    }

    function renderMethodAccountsList() {
      const box = $("methodAccountsList");
      if (!box) return;
      if (!state.methodConfigured) {
        box.innerHTML = "";
        return;
      }
      const rows = Array.isArray(state.methodAccounts) ? state.methodAccounts : [];
      if (!rows.length) {
        box.innerHTML = `<div class="empty">${escapeHtml(t("method_empty_sync"))}</div>`;
        return;
      }
      let html = "";
      rows.forEach((row) => {
        const id = row.method_account_id || "";
        const sid = safeMethodDomId(id);
        const title = escapeHtml(methodDebtTitleFromRow(row));
        const cap = !!row.payment_capable;
        const badge = cap
          ? `<span class="pill green">${escapeHtml(t("method_capable_badge"))}</span>`
          : `<span class="pill gray">${escapeHtml(t("method_info_badge"))}</span>`;
        const imported = row.imported_debt_id
          ? `<span class="pill blue">${escapeHtml(t("method_imported_badge"))}</span>`
          : "";
        const importBlock = row.imported_debt_id
          ? ""
          : `
            <div class="grid-3" style="margin-top:10px;">
              <div class="field">
                <label class="label">${escapeHtml(t("method_import_balance"))}</label>
                <input id="methodBal_${sid}" class="input" type="number" step="0.01" value="0" />
              </div>
              <div class="field">
                <label class="label">${escapeHtml(t("method_import_apr"))}</label>
                <input id="methodApr_${sid}" class="input" type="number" step="0.01" value="0" />
              </div>
              <div class="field">
                <label class="label">${escapeHtml(t("method_import_min"))}</label>
                <input id="methodMin_${sid}" class="input" type="number" step="0.01" value="0" />
              </div>
            </div>
            <div style="margin-top:8px;">
              <button type="button" class="btn btn-secondary btn-small" data-method-import="${escapeHtml(id)}">${escapeHtml(
            t("method_btn_import")
          )}</button>
            </div>`;
        html += `
          <div class="mini-card" style="margin-bottom:8px;">
            <div class="item-top">
              <div>
                <div class="item-title">${title}</div>
                <div class="item-meta" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                  ${badge}${imported}
                  <span class="muted">${escapeHtml(id)}</span>
                </div>
              </div>
            </div>
            ${importBlock}
          </div>`;
      });
      box.innerHTML = html;
      box.querySelectorAll("[data-method-import]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const accId = btn.getAttribute("data-method-import");
          if (!accId) return;
          await importMethodDebtToDebtya(accId);
        });
      });
    }

    function parseMethodConfiguredFromPayload(obj) {
      const v = obj && typeof obj === "object" ? obj.method_configured : undefined;
      if (v === true) return true;
      if (v === 1) return true;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        return s === "true" || s === "1" || s === "yes";
      }
      return false;
    }

    async function refreshMethodSection() {
      state.methodEntitiesLoadError = null;
      let configured = false;
      try {
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), 12000);
        const [stRes, healthRes] = await Promise.all([
          fetch(`${API_BASE}/method/status`, { method: "GET", cache: "no-store", signal: ac.signal }),
          fetch(`${API_BASE}/health`, { method: "GET", cache: "no-store", signal: ac.signal })
        ]);
        clearTimeout(tid);
        const st = stRes.ok ? await stRes.json().catch(() => ({})) : {};
        const health = healthRes.ok ? await healthRes.json().catch(() => ({})) : {};
        const hdr =
          healthRes && healthRes.ok
            ? healthRes.headers.get("X-Debtya-Server-Version") || healthRes.headers.get("x-debtya-server-version")
            : null;
        if (health && typeof health === "object") {
          renderDebtyaRevBadge(health.server_version || hdr || null);
        } else if (hdr) {
          renderDebtyaRevBadge(hdr);
        }
        configured =
          parseMethodConfiguredFromPayload(st) || parseMethodConfiguredFromPayload(health);
      } catch (_) {
        configured = false;
      }
      state.methodConfigured = configured;
      updateMethodPanelHint();
      const token = await getAccessToken();
      if (!token || !state.methodConfigured) {
        state.methodEntities = [];
        state.methodAccounts = [];
        populateMethodEntityPick();
        renderMethodAccountsList();
        return;
      }
      try {
        const [entRes, acctRes] = await Promise.all([api("/method/entities"), api("/method/accounts")]);
        state.methodEntities = (entRes && entRes.data) || [];
        state.methodAccounts = (acctRes && acctRes.data) || [];
        state.methodEntitiesLoadError = null;
      } catch (e) {
        state.methodEntities = [];
        state.methodAccounts = [];
        state.methodEntitiesLoadError = displayMethodSectionError(
          e && typeof e.message === "string" ? e.message : ""
        );
      }
      populateMethodEntityPick();
      renderMethodAccountsList();
    }

    async function refreshBillingStatus() {
      try {
        const res = await api("/billing/subscription-status");
        let data = res.data || null;
        if (data && typeof data.promo_codes_configured === "undefined") {
          try {
            const peRes = await fetch(`${API_BASE}/billing/promo-env`);
            const pe = peRes.ok ? await peRes.json() : null;
            if (pe && typeof pe.promo_codes_configured === "boolean") {
              data = { ...data, promo_codes_configured: pe.promo_codes_configured };
            }
          } catch (_) {}
        }
        state.billing = data;
      } catch {
        state.billing = {
          status: "inactive",
          active: false,
          current_period_end: null,
          stripe_customer_id: null,
          stripe_subscription_id: null,
          cancel_at_period_end: false,
          promo_codes_configured: null
        };
      }
      renderBilling();
    }

    async function refreshAll() {
      hideMessage(globalMessage);
      try {
        await Promise.all([
          refreshPlan(),
          refreshBillingStatus(),
          refreshRules(),
          refreshIntents(),
          refreshTrace(),
          refreshPlaidItems()
        ]);
        await refreshAccounts();
        await refreshDebts();
      } catch (e) {
        showMessage(globalMessage, normalizeErrorMessage(e.message), "error");
      }
      try {
        await refreshSpinwheelPayableDiag();
      } catch (_) {}
      try {
        await refreshMethodSection();
      } catch (e2) {
        state.methodEntitiesLoadError = displayMethodSectionError(e2 && e2.message ? String(e2.message) : "");
        populateMethodEntityPick();
      }
    }

    async function connectBankDirect(){
      const btn = $("btnConnectBank");
      try {
        const token = await getAccessToken();
        if (!token) throw new Error(t("sign_in_first"));
        if (!window.Plaid) throw new Error(t("plaid_script"));

        const rolePick = await openBankConnectionRoleChoice();
        if (!rolePick) return;
        const chosenConnectionRole = normalizePlaidConnectionRoleClient(rolePick);

        setLoading(btn, true, t("plaid_opening"));

        const tokenRes = await api("/plaid/create_link_token", {
          method: "POST",
          body: "{}"
        });

        const linkToken = tokenRes.link_token;
        if (!linkToken) throw new Error(t("no_link_token"));

        const handler = window.Plaid.create({
          token: linkToken,
          onSuccess: async (public_token, metadata) => {
            try {
              showMessage(globalMessage, t("connecting_bank"), "warn");

              const exch = await api("/plaid/exchange_public_token", {
                method: "POST",
                body: JSON.stringify({
                  public_token,
                  metadata,
                  connection_role: chosenConnectionRole
                })
              });

              setBankExchangeFlag();
              showMessage(globalMessage, t("bank_ok"), "success");
              try {
                await api("/plaid/accounts/import", { method: "POST", body: "{}" });
              } catch (_) {}
              await refreshAccounts();
              mergePlaidItemFromExchangeIfMissing(exch?.item);
            } catch (err) {
              showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
            } finally {
              setLoading(btn, false);
            }
          },
          onExit: (err) => {
            if (err) {
              showMessage(globalMessage, normalizeErrorMessage(err.display_message || err.error_message || t("err_plaid_exit")), "error");
            }
            setLoading(btn, false);
          }
        });

        handler.open();
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
        setLoading(btn, false);
      }
    }

    async function login(email, password) {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      clearPwRecoveryPending();
      return data;
    }

    function signupPasswordMeetsPolicy(pw) {
      if (typeof pw !== "string" || pw.length < 8) return false;
      if (!/[A-Z]/.test(pw)) return false;
      if (!/[a-z]/.test(pw)) return false;
      if (!/[0-9]/.test(pw)) return false;
      if (!/[^A-Za-z0-9]/.test(pw)) return false;
      return true;
    }

    async function resetPassword(email) {
      await ensureDebtyaApiBaseProbed();
      const res = await fetch(`${API_BASE}/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, lang: uiLang })
      });
      try {
        const echo = res.headers.get("Debtya-Api-Base") || res.headers.get("debtya-api-base");
        if (echo && String(echo).trim()) {
          const v = String(echo).trim().replace(/\/+$/, "");
          localStorage.setItem("DEBTYA_API_BASE", v);
          API_BASE = v;
        }
      } catch (_) {}
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const parts = [json.error, json.details].filter(Boolean);
        throw new Error(parts.join(" ? ") || `HTTP ${res.status}`);
      }
      return json;
    }

    async function logout() {
      clearPwRecoveryPending();
      await supabaseClient.auth.signOut();
      localStorage.removeItem("debtya_access_token");
      try {
        localStorage.removeItem(LS_BANK_EXCHANGED);
        sessionStorage.removeItem(LS_BANK_DISCONNECT_PENDING);
      } catch (e) {}
      window.location.href = "https://www.debtya.com/";
    }

    async function startCheckout(buttonEl = null) {
      try {
        trackEvent("subscribe_click", { cta_id: buttonEl && buttonEl.id ? buttonEl.id : null });
        if (buttonEl) setLoading(buttonEl, true, t("stripe_opening"));

        const token = await getAccessToken();
        if (!token) {
          showAuth("login");
          showMessage(authMessage, t("checkout_need_auth"), "warn");
          return;
        }

        trackEvent("begin_checkout", { cta_id: buttonEl && buttonEl.id ? buttonEl.id : null });
        const res = await api("/stripe/create-checkout-session", {
          method: "POST",
          body: JSON.stringify({
            success_url: "https://www.debtya.com/?checkout=success",
            cancel_url: "https://www.debtya.com/?checkout=cancel"
          })
        });

        if (!res?.url) {
          throw new Error(t("err_checkout_url"));
        }

        window.location.assign(res.url);
      } catch (e) {
        const msg = normalizeErrorMessage(e.message);
        if (!appView.classList.contains("hidden")) {
          showMessage(globalMessage, msg, "error");
        } else {
          showMessage(authMessage, msg, "error");
        }
      } finally {
        if (buttonEl) setLoading(buttonEl, false);
      }
    }

    async function applyPromoCompCode(buttonEl = null) {
      const input = $("promoCompCode");
      const code = String(input?.value || "").trim();
      if (!code) {
        showMessage(globalMessage, t("promo_comp_need"), "warn");
        return;
      }
      try {
        if (buttonEl) setLoading(buttonEl, true, t("proc"));
        const res = await api("/billing/redeem-promo-code", {
          method: "POST",
          body: JSON.stringify({ code })
        });
        state.billing = res.data || state.billing;
        renderBilling();
        showMessage(
          globalMessage,
          res.already ? t("promo_comp_already") : t("promo_comp_ok"),
          "success"
        );
        if (input) input.value = "";
        updateNextActionGuide();
      } catch (e) {
        showMessage(globalMessage, normalizeErrorMessage(e.message), "error");
      } finally {
        if (buttonEl) setLoading(buttonEl, false);
      }
    }

    async function openBillingPortal(buttonEl = null) {
      try {
        if (buttonEl) setLoading(buttonEl, true, t("portal_opening"));

        const res = await api("/stripe/create-portal-session", {
          method: "POST",
          body: JSON.stringify({
            return_url: "https://www.debtya.com/"
          })
        });

        if (!res?.url) {
          throw new Error(t("err_portal_url"));
        }

        window.location.assign(res.url);
      } catch (e) {
        showMessage(globalMessage, normalizeErrorMessage(e.message), "error");
      } finally {
        if (buttonEl) setLoading(buttonEl, false);
      }
    }

    async function handleCheckoutReturn() {
      if (isPwRecoveryPending()) return;
      const params = new URLSearchParams(window.location.search);
      const checkoutState = params.get("checkout");
      if (!checkoutState) return;

      if (state.session) {
        showApp();
        if (checkoutState === "success") {
          showMessage(globalMessage, t("checkout_done_refresh"), "success");
          await refreshBillingStatus();
        } else if (checkoutState === "cancel") {
          showMessage(globalMessage, t("checkout_cancel"), "warn");
        }
      } else {
        showAuth("login");
        if (checkoutState === "success") {
          showMessage(authMessage, t("checkout_done_signin"), "success");
        } else if (checkoutState === "cancel") {
          showMessage(authMessage, t("checkout_cancel"), "warn");
        }
      }

      const cleanUrl = `${window.location.origin}${window.location.pathname}`;
      window.history.replaceState({}, document.title, cleanUrl);
    }

    function normalizeBankDisconnectPathInUrl() {
      try {
        const u = new URL(window.location.href);
        const p = u.pathname.replace(/\/+$/, "") || "/";
        const deepPaths = ["/bank-disconnect", "/disconnect-bank.html", "/plaid/manage-disconnect"];
        if (deepPaths.includes(p)) {
          window.history.replaceState({}, document.title, "/");
          sessionStorage.setItem(LS_BANK_DISCONNECT_PENDING, "1");
          return;
        }
        if (u.searchParams.get("debtya_bank_disconnect") === "1" || u.searchParams.get("bank_disconnect") === "1") {
          u.searchParams.delete("debtya_bank_disconnect");
          u.searchParams.delete("bank_disconnect");
          const qs = u.searchParams.toString();
          const next = `${u.pathname}${qs ? `?${qs}` : ""}${u.hash}`;
          window.history.replaceState({}, document.title, next || "/");
          sessionStorage.setItem(LS_BANK_DISCONNECT_PENDING, "1");
        }
      } catch (_) {}
    }

    async function maybeOpenPendingBankDisconnectFlow() {
      try {
        if (sessionStorage.getItem(LS_BANK_DISCONNECT_PENDING) !== "1") return;
        const storedToken = getStoredAccessToken();
        if (!(state.session || storedToken)) return;
        sessionStorage.removeItem(LS_BANK_DISCONNECT_PENDING);
        await openBankPickDisconnectFlow();
      } catch (_) {}
    }

    async function loadSession() {
      patchOverviewPanelLayout();
      await ensureDebtyaApiBaseProbed();
      await probeDebtyaDeployBadge();
      normalizeBankDisconnectPathInUrl();

      async function pullSession() {
        try {
          const { data } = await supabaseClient.auth.getSession();
          state.session = data?.session || null;
          state.user = state.session?.user || null;
        } catch {
          state.session = null;
          state.user = null;
        }
      }

      await pullSession();

      if (new URLSearchParams(window.location.search || "").has("code")) {
        await new Promise((r) => setTimeout(r, 120));
        await pullSession();
      }

      if (isPwRecoveryPending()) {
        for (let i = 0; i < 20 && !state.session; i++) {
          await new Promise((r) => setTimeout(r, 100));
          await pullSession();
        }
      }

      if (state.session && sessionLooksLikePasswordRecovery(state.session)) {
        setPwRecoveryPending();
      }

      const storedToken = getStoredAccessToken();
      if (storedToken) {
        localStorage.setItem("debtya_access_token", storedToken);
      }

      renderUser();

      if (isPwRecoveryPending() && state.session) {
        showPasswordRecoveryPanel();
        await handleCheckoutReturn();
        await maybeOpenPendingBankDisconnectFlow();
        return;
      }

      if (isPwRecoveryPending() && !state.session) {
        const qs = new URLSearchParams(window.location.search || "");
        if (!qs.has("code")) clearPwRecoveryPending();
      }

      if (state.session || storedToken) {
        showApp();
        await refreshAll();
      } else {
        showLanding();
      }

      await handleCheckoutReturn();
      await maybeOpenPendingBankDisconnectFlow();
    }

    async function approveIntent(id) {
      try {
        await api(`/payment-intents/${id}/approve`, { method: "POST", body: "{}" });
        showMessage(globalMessage, t("intent_ok"), "success");
        await refreshIntents();
      } catch (e) {
        showMessage(globalMessage, normalizeErrorMessage(e.message), "error");
      }
    }

    async function executeIntent(id) {
      try {
        await api(`/payment-intents/${id}/execute`, { method: "POST", body: "{}" });
        showMessage(globalMessage, t("intent_exec_ok"), "success");
        await Promise.all([refreshIntents(), refreshDebts(), refreshTrace()]);
      } catch (e) {
        showMessage(globalMessage, normalizeErrorMessage(e.message), "error");
      }
    }

    async function deleteRule(id) {
      if (!id) return;
      const confirmed = window.confirm(t("rule_delete_confirm"));
      if (!confirmed) return;
      try {
        if (String(state.editingRuleId) === String(id)) state.editingRuleId = null;
        await api(`/rules/${id}`, { method: "DELETE" });
        showMessage(globalMessage, t("rule_deleted"), "success");
        await refreshRules();
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      }
    }

    function beginEditRule(id) {
      const rule = (state.rules || []).find((r) => String(r.id) === String(id));
      if (!rule) return;
      renderDebtTargetOptions();
      state.editingRuleId = rule.id;
      populateRuleFormFromRule(rule);
      syncRuleModeFields();
      updateRuleModeHint();
      updateRuleFormLock();
    }

    async function cancelEditRule() {
      state.editingRuleId = null;
      await refreshRules();
      const rules = state.rules || [];
      if (rules.length === 1) {
        renderDebtTargetOptions();
        populateRuleFormFromRule(rules[0]);
      }
      updateRuleFormLock();
    }

    async function onHeroRulesSwitchChange(ev) {
      const sw = ev.target;
      if (!sw || sw.id !== "heroRulesEnabledSwitch") return;
      const rule = (state.rules || [])[0];
      if (!rule) {
        sw.checked = false;
        return;
      }
      const want = !!sw.checked;
      const prev = !!rule.enabled;
      try {
        await api(`/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ enabled: want }) });
        showMessage(globalMessage, want ? t("rule_enabled_ok") : t("rule_disabled_ok"), "success");
        await refreshRules();
      } catch (err) {
        sw.checked = prev;
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      }
    }

    window.approveIntent = approveIntent;
    window.executeIntent = executeIntent;
    window.deleteRule = deleteRule;
    window.beginEditRule = beginEditRule;

    $("landingLoginBtn").addEventListener("click", () => {
      trackEvent("login_click", { cta_id: "landingLoginBtn" });
      showAuth("login");
    });
    $("landingSignupBtn").addEventListener("click", () => showAuth("signup"));
    $("landingStartBtn").addEventListener("click", () => startCheckout($("landingStartBtn")));
    $("pricingStartBtn").addEventListener("click", () => startCheckout($("pricingStartBtn")));
    $("pricingLoginBtn").addEventListener("click", () => {
      trackEvent("login_click", { cta_id: "pricingLoginBtn" });
      showAuth("login");
    });

    document.addEventListener("click", (ev) => {
      const bubble = ev.target && ev.target.closest(".info-bubble-btn");
      if (!bubble) return;
      const hint = String(bubble.getAttribute("title") || "").trim();
      if (!hint) return;
      ev.preventDefault();
      showMessage(globalMessage, hint, "success");
    });

    const helpFabBtn = $("helpFab");
    if (helpFabBtn) helpFabBtn.addEventListener("click", () => openHelpModal());
    const helpBackdrop = $("helpModalBackdrop");
    if (helpBackdrop) helpBackdrop.addEventListener("click", closeHelpModal);
    const helpCloseBtn = $("helpModalClose");
    if (helpCloseBtn) helpCloseBtn.addEventListener("click", closeHelpModal);
    document.querySelectorAll(".help-tab[data-help-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        const name = tab.getAttribute("data-help-tab");
        if (name) setHelpModalTab(name);
      });
    });
    const helpSendBtn = $("helpChatSend");
    if (helpSendBtn) helpSendBtn.addEventListener("click", () => sendHelpAssistantMessage());
    const helpChatInput = $("helpChatInput");
    if (helpChatInput) {
      helpChatInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          sendHelpAssistantMessage();
        }
      });
    }
    const helpJumpFaqBtn = $("helpJumpFaqBtn");
    if (helpJumpFaqBtn) {
      helpJumpFaqBtn.addEventListener("click", () => {
        closeHelpModal();
      });
    }

    const bankPickBackdrop = $("bankPickBackdrop");
    if (bankPickBackdrop) bankPickBackdrop.addEventListener("click", closeBankPickModal);
    const bankPickCancel = $("bankPickCancel");
    if (bankPickCancel) bankPickCancel.addEventListener("click", closeBankPickModal);
    const bankPickContinue = $("bankPickContinue");
    if (bankPickContinue) bankPickContinue.addEventListener("click", () => confirmBankPickContinue());

    const bankDcBackdrop = $("bankDcBackdrop");
    if (bankDcBackdrop) bankDcBackdrop.addEventListener("click", closeBankDisconnectModal);
    const bankDcCancel = $("bankDcCancel");
    if (bankDcCancel) bankDcCancel.addEventListener("click", closeBankDisconnectModal);
    const bankDcConfirm = $("bankDcConfirm");
    if (bankDcConfirm) bankDcConfirm.addEventListener("click", () => confirmDisconnectPlaidBank());

    const bankRoleBackdrop = $("bankRoleBackdrop");
    if (bankRoleBackdrop) bankRoleBackdrop.addEventListener("click", () => finishBankConnectionRoleChoice(null));
    const bankRoleCancelBtn = $("bankRoleCancelBtn");
    if (bankRoleCancelBtn) bankRoleCancelBtn.addEventListener("click", () => finishBankConnectionRoleChoice(null));
    const bankRoleFundingBtn = $("bankRoleFundingBtn");
    if (bankRoleFundingBtn) bankRoleFundingBtn.addEventListener("click", () => finishBankConnectionRoleChoice("funding"));
    const bankRoleLiabilitiesBtn = $("bankRoleLiabilitiesBtn");
    if (bankRoleLiabilitiesBtn) bankRoleLiabilitiesBtn.addEventListener("click", () => finishBankConnectionRoleChoice("liabilities"));
    const bankRoleBothBtn = $("bankRoleBothBtn");
    if (bankRoleBothBtn) bankRoleBothBtn.addEventListener("click", () => finishBankConnectionRoleChoice("both"));

    ["btnDisconnectBank", "accountsDisconnectBankBtn"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", () => openBankPickDisconnectFlow());
    });
    updateDisconnectBankButton();

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      const pickRoot = $("bankPickDisconnectModal");
      if (pickRoot && !pickRoot.classList.contains("hidden")) {
        closeBankPickModal();
        return;
      }
      const roleRoot = $("bankConnectionRoleModal");
      if (roleRoot && !roleRoot.classList.contains("hidden")) {
        finishBankConnectionRoleChoice(null);
        return;
      }
      const bankRoot = $("bankDisconnectModal");
      if (bankRoot && !bankRoot.classList.contains("hidden")) {
        closeBankDisconnectModal();
        return;
      }
      const root = $("helpModalRoot");
      if (root && !root.classList.contains("hidden")) closeHelpModal();
    });

    $("showLoginBtn").addEventListener("click", () => {
      trackEvent("login_click", { cta_id: "showLoginBtn" });
      state.mode = "login";
      updateAuthModeUI();
      hideMessage(authMessage);
    });

    $("showSignupBtn").addEventListener("click", () => {
      state.mode = "signup";
      updateAuthModeUI();
      hideMessage(authMessage);
    });

    authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideMessage(authMessage);
      const authSubmitLoadingLabel =
        state.mode === "signup" && state.signupVerificationPending
          ? t("creating_acct")
          : state.mode === "signup"
            ? t("signup_sending_code")
            : state.mode === "login" && state.loginVerificationPending
              ? t("signing_in")
              : state.mode === "login"
                ? t("login_sending_code")
                : t("signing_in");
      setLoading(authSubmitBtn, true, authSubmitLoadingLabel);
      try {
        const email = authEmail.value.trim();
        const password = authPassword.value.trim();

        if (state.mode === "login") {
          await ensureDebtyaApiBaseProbed();
          if (!email || !password) throw new Error(t("fill_email_pw"));
          const emailNorm = email.toLowerCase();

          if (!state.loginVerificationPending) {
            const sendRes = await fetch(`${API_BASE}/auth/login/send-verification-code`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, password, lang: uiLang })
            });
            const sendJson = await sendRes.json().catch(() => ({}));
            if (!sendRes.ok) {
              const parts = [sendJson.error, sendJson.details].filter(Boolean);
              throw new Error(parts.join(" ? ") || `HTTP ${sendRes.status}`);
            }
            state.loginVerificationPending = true;
            state.loginVerificationEmail = emailNorm;
            updateAuthModeUI();
            const codeInput = $("authSignupVerifyCode");
            if (codeInput) {
              codeInput.value = "";
              try {
                codeInput.focus();
              } catch (_) {}
            }
            showMessage(authMessage, t("login_check_email_code"), "success");
            return;
          }

          if (state.loginVerificationEmail && emailNorm !== state.loginVerificationEmail) {
            state.loginVerificationPending = false;
            state.loginVerificationEmail = null;
            updateAuthModeUI();
            throw new Error(t("login_email_changed_reenter"));
          }

          const verifyCode = String($("authSignupVerifyCode")?.value || "").trim();
          if (!/^\d{6}$/.test(verifyCode)) {
            throw new Error(t("err_signup_code_invalid"));
          }
          const loginRes = await fetch(`${API_BASE}/auth/login/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, code: verifyCode, lang: uiLang })
          });
          const loginJson = await loginRes.json().catch(() => ({}));
          if (!loginRes.ok) {
            const parts = [loginJson.error, loginJson.details].filter(Boolean);
            throw new Error(parts.join(" ? ") || `HTTP ${loginRes.status}`);
          }
          if (!loginJson.session?.access_token || !loginJson.session?.refresh_token) {
            throw new Error(t("err_generic"));
          }
          const { error: setSessErr } = await supabaseClient.auth.setSession({
            access_token: loginJson.session.access_token,
            refresh_token: loginJson.session.refresh_token
          });
          if (setSessErr) throw setSessErr;
          clearPwRecoveryPending();
          state.loginVerificationPending = false;
          state.loginVerificationEmail = null;
          const codeEl = $("authSignupVerifyCode");
          if (codeEl) codeEl.value = "";
          updateAuthModeUI();
          showMessage(authMessage, t("session_ok"), "success");
        } else {
          const passwordConfirm = String($("authPasswordConfirm")?.value || "").trim();
          if (!email) throw new Error(t("enter_email_first"));
          if (!password || !passwordConfirm) {
            throw new Error(t("err_signup_password_pair_required"));
          }
          if (password !== passwordConfirm) {
            throw new Error(t("err_password_mismatch"));
          }
          if (!signupPasswordMeetsPolicy(password)) {
            throw new Error(t("err_password_policy"));
          }

          const emailNorm = email.toLowerCase();

          if (!state.signupVerificationPending) {
            const sendRes = await fetch(`${API_BASE}/auth/signup/send-verification-code`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email, lang: uiLang })
            });
            const sendJson = await sendRes.json().catch(() => ({}));
            if (!sendRes.ok) {
              const parts = [sendJson.error, sendJson.details].filter(Boolean);
              throw new Error(parts.join(" ? ") || `HTTP ${sendRes.status}`);
            }
            state.signupVerificationPending = true;
            state.signupVerificationEmail = emailNorm;
            updateAuthModeUI();
            const codeInput = $("authSignupVerifyCode");
            if (codeInput) {
              codeInput.value = "";
              try {
                codeInput.focus();
              } catch (_) {}
            }
            showMessage(authMessage, t("signup_check_email_code"), "success");
            return;
          }

          if (state.signupVerificationEmail && emailNorm !== state.signupVerificationEmail) {
            state.signupVerificationPending = false;
            state.signupVerificationEmail = null;
            updateAuthModeUI();
            throw new Error(t("signup_email_changed_reenter"));
          }

          const verifyCode = String($("authSignupVerifyCode")?.value || "").trim();
          if (!/^\d{6}$/.test(verifyCode)) {
            throw new Error(t("err_signup_code_invalid"));
          }
          const regRes = await fetch(`${API_BASE}/auth/signup/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, code: verifyCode, lang: uiLang })
          });
          const regJson = await regRes.json().catch(() => ({}));
          if (!regRes.ok) {
            const parts = [regJson.error, regJson.details].filter(Boolean);
            throw new Error(parts.join(" ? ") || `HTTP ${regRes.status}`);
          }
          state.signupVerificationPending = false;
          state.signupVerificationEmail = null;
          const codeEl = $("authSignupVerifyCode");
          if (codeEl) codeEl.value = "";
          updateAuthModeUI();
          await login(email, password);
          showMessage(authMessage, t("session_ok"), "success");
        }

        await loadSession();
      } catch (e2) {
        showMessage(authMessage, normalizeErrorMessage(e2.message), "error");
      } finally {
        setLoading(authSubmitBtn, false);
      }
    });

    $("resetPasswordBtn").addEventListener("click", async () => {
      hideMessage(authMessage);
      try {
        const email = authEmail.value.trim();
        if (!email) throw new Error(t("enter_email_first"));
        const json = await resetPassword(email);
        showMessage(authMessage, json?.message || t("pw_reset_sent"), "success");
      } catch (e) {
        showMessage(authMessage, normalizeErrorMessage(e.message), "error");
      }
    });

    const pwRecoveryMsg = $("pwRecoveryMessage");
    function hidePwRecoveryMessage() {
      hideMessage(pwRecoveryMsg);
    }

    $("pwRecoverySendCodeBtn").addEventListener("click", async () => {
      hidePwRecoveryMessage();
      const btn = $("pwRecoverySendCodeBtn");
      try {
        const token = await getAccessToken();
        if (!token) throw new Error(t("err_generic"));
        setLoading(btn, true, t("signup_sending_code"));
        const res = await fetch(`${API_BASE}/auth/password-reset/session/send-code`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ lang: uiLang })
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const parts = [json.error, json.details].filter(Boolean);
          throw new Error(parts.join(" ? ") || `HTTP ${res.status}`);
        }
        showMessage(pwRecoveryMsg, json?.message || t("pw_recovery_code_sent"), "success");
      } catch (e) {
        showMessage(pwRecoveryMsg, normalizeErrorMessage(e.message), "error");
      } finally {
        setLoading(btn, false);
      }
    });

    $("pwRecoverySubmitBtn").addEventListener("click", async () => {
      hidePwRecoveryMessage();
      const btn = $("pwRecoverySubmitBtn");
      try {
        const token = await getAccessToken();
        if (!token) throw new Error(t("err_generic"));
        const pw = String($("pwRecoveryNew")?.value || "").trim();
        const pw2 = String($("pwRecoveryConfirm")?.value || "").trim();
        const code = String($("pwRecoveryCode")?.value || "").trim();
        if (!pw || !pw2) throw new Error(t("err_signup_password_pair_required"));
        if (pw !== pw2) throw new Error(t("err_password_mismatch"));
        if (!signupPasswordMeetsPolicy(pw)) throw new Error(t("err_password_policy"));
        if (!/^\d{6}$/.test(code)) throw new Error(t("err_signup_code_invalid"));
        setLoading(btn, true, t("proc"));
        const res = await fetch(`${API_BASE}/auth/password-reset/session/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ password: pw, code, lang: uiLang })
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const parts = [json.error, json.details].filter(Boolean);
          throw new Error(parts.join(" ? ") || `HTTP ${res.status}`);
        }
        clearPwRecoveryPending();
        hidePasswordRecoveryPanel();
        $("pwRecoveryNew").value = "";
        $("pwRecoveryConfirm").value = "";
        $("pwRecoveryCode").value = "";
        showApp();
        showMessage(globalMessage, json?.message || t("pw_recovery_done"), "success");
        await refreshAll();
      } catch (e) {
        showMessage(pwRecoveryMsg, normalizeErrorMessage(e.message), "error");
      } finally {
        setLoading(btn, false);
      }
    });

    $("pwRecoveryCancelBtn").addEventListener("click", async () => {
      hidePwRecoveryMessage();
      try {
        await supabaseClient.auth.signOut();
        localStorage.removeItem("debtya_access_token");
      } catch (_) {}
      clearPwRecoveryPending();
      hidePasswordRecoveryPanel();
      state.session = null;
      state.user = null;
      showAuth("login");
    });

    $("logoutBtn").addEventListener("click", logout);
    $("refreshDebtsBtn").addEventListener("click", refreshDebts);
    const spinwheelPayableDiagRefreshBtn = $("spinwheelPayableDiagRefreshBtn");
    if (spinwheelPayableDiagRefreshBtn) {
      spinwheelPayableDiagRefreshBtn.addEventListener("click", () => void refreshSpinwheelPayableDiag());
    }
    const swConnectSearchBtn = $("swConnectSearchBtn");
    if (swConnectSearchBtn) swConnectSearchBtn.addEventListener("click", () => void onSwConnectSearchClick());
    const swConnectVerifyBtn = $("swConnectVerifyBtn");
    if (swConnectVerifyBtn) swConnectVerifyBtn.addEventListener("click", () => void onSwConnectVerifyClick());
    window.addEventListener("hashchange", () => void refreshSpinwheelPayableDiag());
    $("refreshRulesBtn").addEventListener("click", refreshRules);
    $("refreshPlanBtn").addEventListener("click", refreshPlan);
    $("planStrategy").addEventListener("change", updatePlanFieldHints);
    $("planMode").addEventListener("change", updatePlanFieldHints);
    $("refreshIntentsBtn").addEventListener("click", refreshIntents);
    const refreshIntentsToolbarBtn = $("refreshIntentsToolbarBtn");
    if (refreshIntentsToolbarBtn) {
      refreshIntentsToolbarBtn.addEventListener("click", async () => {
        setLoading(refreshIntentsToolbarBtn, true, t("proc"));
        try {
          await refreshIntents();
        } catch (err) {
          showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
        } finally {
          setLoading(refreshIntentsToolbarBtn, false);
        }
      });
    }
    $("refreshTraceBtn").addEventListener("click", refreshTrace);
    $("refreshAccountsBtn").addEventListener("click", refreshAccounts);
    const refreshBillingBtn = $("refreshBillingBtn");
    if (refreshBillingBtn) refreshBillingBtn.addEventListener("click", refreshBillingStatus);
    const billingStartBtn = $("billingStartBtn");
    if (billingStartBtn) billingStartBtn.addEventListener("click", () => startCheckout($("billingStartBtn")));
    $("topUpgradeBtn").addEventListener("click", () => startCheckout($("topUpgradeBtn")));
    const promoCompBtn = $("promoCompBtn");
    if (promoCompBtn) promoCompBtn.addEventListener("click", () => applyPromoCompCode($("promoCompBtn")));
    const billingManageBtn = $("billingManageBtn");
    if (billingManageBtn) billingManageBtn.addEventListener("click", () => openBillingPortal($("billingManageBtn")));
    $("topManageBillingBtn").addEventListener("click", () => openBillingPortal($("topManageBillingBtn")));
    $("btnConnectBank").addEventListener("click", connectBankDirect);

    const heroRulesSwitchEl = $("heroRulesEnabledSwitch");
    if (heroRulesSwitchEl) heroRulesSwitchEl.addEventListener("change", onHeroRulesSwitchChange);
    const ruleCancelEditBtn = $("ruleCancelEditBtn");
    if (ruleCancelEditBtn) ruleCancelEditBtn.addEventListener("click", () => cancelEditRule());

    $("debtFromAccountSelect").addEventListener("change", () => {
      const id = $("debtFromAccountSelect").value;
      const nameHint = $("debtNameSuggestedHint");
      if (!id) {
        if (nameHint) nameHint.classList.add("hidden");
        const minH = $("debtMinPaymentSuggestedHint");
        if (minH) minH.classList.add("hidden");
        const aprH = $("debtAprSuggestedHint");
        if (aprH) aprH.classList.add("hidden");
        updateDebtSuggestedFieldHighlights(false, false);
        return;
      }
      fillDebtFormFromPlaidAccount(id);
    });

    $("debtForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const payload = {
          name: $("debtName").value.trim(),
          balance: Number($("debtBalance").value),
          apr: Number($("debtApr").value),
          minimum_payment: Number($("debtMinPayment").value),
          due_day: $("debtDueDay").value ? Number($("debtDueDay").value) : null,
          type: $("debtType").value
        };
        const linkPick = $("debtLinkedPlaid")?.value?.trim();
        if (linkPick) payload.linked_plaid_account_id = linkPick;
        await api("/debts", { method: "POST", body: JSON.stringify(payload) });
        showMessage(globalMessage, t("debt_saved"), "success");
        e.target.reset();
        $("debtType").value = "credit_card";
        const fromSel = $("debtFromAccountSelect");
        if (fromSel) fromSel.value = "";
        const nameHint = $("debtNameSuggestedHint");
        if (nameHint) nameHint.classList.add("hidden");
        const minHint = $("debtMinPaymentSuggestedHint");
        if (minHint) minHint.classList.add("hidden");
        const aprHint2 = $("debtAprSuggestedHint");
        if (aprHint2) aprHint2.classList.add("hidden");
        updateDebtSuggestedFieldHighlights(false, false);
        await refreshDebts();
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      }
    });

    $("ruleForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const editingId = state.editingRuleId;
        if (!editingId && Array.isArray(state.rules) && state.rules.length > 0) {
          showMessage(globalMessage, t("err_rule_one_only"), "error");
          return;
        }
        const mode = $("ruleMode").value;
        let roundupTo = Number($("ruleRoundupTo").value || 0);
        if (mode === "roundup_change" && (!roundupTo || roundupTo <= 0)) roundupTo = 1;
        const existing = editingId ? (state.rules || []).find((r) => String(r.id) === String(editingId)) : null;
        const payload = {
          mode,
          percent: mode === "roundup_percent" ? Number($("rulePercent").value || 0) : 0,
          fixed_amount: mode === "fixed_amount" ? Number($("ruleFixedAmount").value || 0) : 0,
          roundup_to:
            mode === "roundup_change"
              ? roundupTo
              : mode === "roundup_percent"
                ? 0
                : 1,
          min_purchase_amount: getRuleMinPurchaseForSubmit(),
          target_debt_id: $("ruleTargetDebt").value || null,
          enabled: existing ? !!existing.enabled : true
        };
        if (editingId) {
          await api(`/rules/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
          showMessage(globalMessage, t("rule_updated"), "success");
          state.editingRuleId = null;
        } else {
          await api("/rules", { method: "POST", body: JSON.stringify({ ...payload, enabled: true }) });
          showMessage(globalMessage, t("rule_saved"), "success");
        }
        await refreshRules();
      } catch (err) {
        const raw = err?.message || "";
        if (raw === "ERR_ONE_RULE_MAX") {
          showMessage(globalMessage, t("err_rule_one_only"), "error");
        } else {
          showMessage(globalMessage, normalizeErrorMessage(raw), "error");
        }
      }
    });

    $("planForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const payload = {
          strategy: $("planStrategy").value,
          automation_mode: $("planMode").value,
          auto_mode: $("planMode").value,
          monthly_budget_default: Number($("planMonthlyBudget").value || 0),
          monthly_budget: Number($("planMonthlyBudget").value || 0),
          extra_payment_default: Number($("planExtraPayment").value || 0),
          funding_plaid_account_id: $("planFundingAccount").value.trim() || null,
          payment_target_debt_id: $("planPaydownDebt").value.trim() || null
        };
        await api("/payment-plan", { method: "POST", body: JSON.stringify(payload) });
        showMessage(globalMessage, t("plan_saved"), "success");
        await refreshPlan();
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      }
    });

    $("compareStrategyBtn").addEventListener("click", async () => {
      try {
        const payload = {
          monthly_budget_default: Number($("planMonthlyBudget").value || 0),
          extra_payment_default: Number($("planExtraPayment").value || 0)
        };
        const res = await api("/strategy/compare", { method: "POST", body: JSON.stringify(payload) });
        state.lastCompare = res.data;
        renderCompare(res.data);
        showMessage(globalMessage, t("compare_ok"), "success");
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      }
    });

    $("btnImportAccounts").addEventListener("click", async () => {
      const btn = $("btnImportAccounts");
      setLoading(btn, true, t("importing"));
      try {
        const res = await api("/plaid/accounts/import", { method: "POST", body: "{}" });
        showMessage(globalMessage, `${t("accounts_imp")}: ${res.count ?? res.total_accounts ?? 0}.`, "success");
        await refreshAccounts();
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      } finally {
        setLoading(btn, false);
      }
    });

    $("btnImportTransactions").addEventListener("click", async () => {
      const btn = $("btnImportTransactions");
      setLoading(btn, true, t("importing"));
      try {
        const res = await api("/plaid/transactions/sync", { method: "POST", body: "{}" });
        showMessage(globalMessage, `${t("tx_imp")}: ${res.imported ?? res.added ?? 0}.`, "success");
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      } finally {
        setLoading(btn, false);
      }
    });

    $("btnApplyRules").addEventListener("click", async () => {
      const btn = $("btnApplyRules");
      setLoading(btn, true, t("applying"));
      try {
        const res = await api("/rules/apply", { method: "POST", body: "{}" });
        showMessage(globalMessage, `${t("rules_applied")}: ${res.created ?? 0}.`, "success");
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      } finally {
        setLoading(btn, false);
      }
    });

    async function runPaymentIntentsBuild(triggerBtn) {
      const btn = triggerBtn;
      if (btn) setLoading(btn, true, t("building"));
      const fb = $("intentsBuildFeedback");
      const pre = $("intentsBuildResultJson");
      try {
        const res = await api("/payment-intents/build", { method: "POST", body: "{}" });
        if (fb && pre) {
          pre.textContent = JSON.stringify(res, null, 2);
          fb.classList.remove("hidden", "error", "success", "warn");
          fb.classList.add("success");
        }
        showMessage(globalMessage, t("intents_built"), "success");
        await refreshIntents();
        const swApp = toNum(res?.spinwheel_intents?.appended);
        let legacyCreated = 0;
        const pdata = res?.data;
        if (Array.isArray(pdata) && pdata[0] && typeof pdata[0] === "object") {
          legacyCreated = toNum(pdata[0].intents_created ?? pdata[0].intentsCreated);
        } else if (pdata && typeof pdata === "object" && !Array.isArray(pdata)) {
          legacyCreated = toNum(pdata.intents_created ?? pdata.intentsCreated);
        }
        if (swApp > 0 || legacyCreated > 0) {
          await refreshIntents();
          updateNextActionGuide();
        }
      } catch (err) {
        if (fb && pre) {
          pre.textContent = JSON.stringify(
            { ok: false, error: normalizeErrorMessage(err.message) },
            null,
            2
          );
          fb.classList.remove("hidden", "success", "warn");
          fb.classList.add("error");
        }
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      } finally {
        if (btn) setLoading(btn, false);
      }
    }

    const btnBuildIntentsEl = $("btnBuildIntents");
    if (btnBuildIntentsEl) btnBuildIntentsEl.addEventListener("click", () => runPaymentIntentsBuild(btnBuildIntentsEl));

    const btnBuildIntentsVisibleEl = $("btnBuildIntentsVisible");
    if (btnBuildIntentsVisibleEl) {
      btnBuildIntentsVisibleEl.addEventListener("click", () => runPaymentIntentsBuild(btnBuildIntentsVisibleEl));
    }

    async function runApproveVisible(btn) {
      setLoading(btn, true, t("approving"));
      try {
        const res = await api("/payment-intents/approve-visible", { method: "POST", body: "{}" });
        showMessage(globalMessage, `${t("approved_n")}: ${res.approved_count ?? 0}.`, "success");
        await refreshIntents();
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      } finally {
        setLoading(btn, false);
      }
    }

    const btnApproveVisibleEl = $("btnApproveVisible");
    if (btnApproveVisibleEl) btnApproveVisibleEl.addEventListener("click", () => runApproveVisible(btnApproveVisibleEl));
    const btnApproveVisibleMainEl = $("btnApproveVisibleMain");
    if (btnApproveVisibleMainEl) btnApproveVisibleMainEl.addEventListener("click", () => runApproveVisible(btnApproveVisibleMainEl));

    async function runExecuteVisible(btn) {
      setLoading(btn, true, t("executing"));
      try {
        const intents = Array.isArray(state.intents) ? state.intents : [];
        const executable = intents.filter((intent) => {
          const src = String(intent?.source || "").toLowerCase();
          const st = String(intent?.status || "").toLowerCase();
          return src !== "spinwheel" && st === "approved";
        });
        const hasSpinwheel = intents.some((intent) => String(intent?.source || "").toLowerCase() === "spinwheel");
        if (!executable.length) {
          if (hasSpinwheel) {
            showMessage(globalMessage, t("intent_spinwheel_coming_soon"), "warn");
          } else {
            showMessage(globalMessage, `${t("executed_n")}: 0.`, "success");
          }
          return;
        }
        let executedCount = 0;
        for (const intent of executable) {
          await api(`/payment-intents/${intent.id}/execute`, { method: "POST", body: "{}" });
          executedCount += 1;
        }
        showMessage(globalMessage, `${t("executed_n")}: ${executedCount}.`, "success");
        await Promise.all([refreshIntents(), refreshDebts(), refreshTrace()]);
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      } finally {
        setLoading(btn, false);
      }
    }

    const btnExecuteVisibleEl = $("btnExecuteVisible");
    if (btnExecuteVisibleEl) btnExecuteVisibleEl.addEventListener("click", () => runExecuteVisible(btnExecuteVisibleEl));
    const btnExecuteVisibleMainEl = $("btnExecuteVisibleMain");
    if (btnExecuteVisibleMainEl) btnExecuteVisibleMainEl.addEventListener("click", () => runExecuteVisible(btnExecuteVisibleMainEl));

    $("reconcileRecentBtn").addEventListener("click", async () => {
      const btn = $("reconcileRecentBtn");
      setLoading(btn, true, t("reconciling"));
      try {
        const res = await api("/payment-intents/reconcile-recent", {
          method: "POST",
          body: JSON.stringify({ days: 2, limit: 10 })
        });
        showMessage(
          globalMessage,
          `${t("reconcile_ok")}. reviewed=${res.data?.checked ?? 0}, pending=${res.data?.pending ?? 0}.`,
          "success"
        );
        await Promise.all([refreshIntents(), refreshDebts(), refreshTrace()]);
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
      } finally {
        setLoading(btn, false);
      }
    });

    $("debtsList").addEventListener("click", async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".debt-sync-balance-btn") : null;
      if (!btn) return;
      const debtId = btn.getAttribute("data-debt-id");
      const balStr = btn.getAttribute("data-target-balance");
      if (!debtId || balStr === null || balStr === "") return;
      const newBal = Number(balStr);
      if (Number.isNaN(newBal)) return;
      btn.disabled = true;
      try {
        await api(`/debts/${debtId}`, {
          method: "PATCH",
          body: JSON.stringify({ balance: newBal })
        });
        showMessage(globalMessage, t("debt_balance_synced_ok"), "success");
        await refreshDebts();
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
        await refreshDebts();
      } finally {
        btn.disabled = false;
      }
    });

    $("debtsList").addEventListener("change", async (e) => {
      const el = e.target;
      if (!el.classList || !el.classList.contains("debt-plaid-select")) return;
      const debtId = el.getAttribute("data-debt-id");
      if (!debtId) return;
      const val = el.value.trim();
      el.disabled = true;
      try {
        await api(`/debts/${debtId}`, {
          method: "PATCH",
          body: JSON.stringify({ linked_plaid_account_id: val || null })
        });
        showMessage(globalMessage, t("debt_link_saved"), "success");
        await refreshDebts();
      } catch (err) {
        showMessage(globalMessage, normalizeErrorMessage(err.message), "error");
        await refreshDebts();
      } finally {
        el.disabled = false;
      }
    });

    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (session?.access_token && sessionLooksLikePasswordRecovery(session)) {
        setPwRecoveryPending();
      }
      if (event === "PASSWORD_RECOVERY") {
        setPwRecoveryPending();
      }
      try {
        const h = (window.location.hash || "").replace(/^#/, "");
        if (h) {
          const p = new URLSearchParams(h);
          if (
            p.get("type") === "recovery" ||
            /(^|[&])type=recovery(&|$)/.test(h) ||
            h.includes("type%3Drecovery")
          ) {
            setPwRecoveryPending();
          }
        }
      } catch (_) {}

      state.session = session || null;
      state.user = session?.user || null;

      if (session?.access_token) {
        localStorage.setItem("debtya_access_token", session.access_token);
      }

      renderUser();

      if (isPwRecoveryPending() && session) {
        showPasswordRecoveryPanel();
        return;
      }

      if (session || getStoredAccessToken()) {
        showApp();
        await refreshBillingStatus();
      } else {
        state.billing = null;
        renderBilling();
        showLanding();
      }
    });

    syncLangButtons();
    applyDomI18n();
    updatePlanFieldHints();
    updateRuleFormLock();
    const ruleModeEl = $("ruleMode");
    if (ruleModeEl) {
      ruleModeEl.addEventListener("change", () => {
        syncRuleModeFields();
        updateRuleModeHint();
      });
      syncRuleModeFields();
      updateRuleModeHint();
    }
    wireLangButtons();
    updateAuthModeUI();
    loadSession();
