function registerSupabaseRoutes(app, deps) {
  const { supabaseAdmin, jsonError } = deps;

  app.get("/supabase/ping", async (_req, res) => {
    try {
      if (!supabaseAdmin) {
        return jsonError(res, 500, "Supabase no configurado");
      }

      const payload = {
        ping_at: new Date().toISOString()
      };

      const { data, error } = await supabaseAdmin
        .from("debug_pings")
        .insert(payload)
        .select()
        .single();

      if (error) {
        return jsonError(res, 500, "Error insertando en Supabase", {
          details: error.message
        });
      }

      return res.json({ ok: true, data });
    } catch (error) {
      return jsonError(res, 500, error.message);
    }
  });
}

module.exports = { registerSupabaseRoutes };
