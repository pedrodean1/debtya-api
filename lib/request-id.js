const { randomUUID } = require("crypto");

function requestIdMiddleware(req, res, next) {
  const incoming = req.headers["x-request-id"];
  req.requestId =
    typeof incoming === "string" && incoming.trim()
      ? incoming.trim().slice(0, 128)
      : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

module.exports = { requestIdMiddleware };
