/**
 * Respuesta JSON de error unificada: ok, error, request_id (si hay middleware), extras opcionales.
 */
function jsonError(res, status, message, extra = {}) {
  const requestId = res.req?.requestId;
  return res.status(status).json({
    ok: false,
    error: message,
    http_status: status,
    ...(requestId ? { request_id: requestId } : {}),
    ...extra
  });
}

module.exports = { jsonError };
