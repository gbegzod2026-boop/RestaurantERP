const STAFF_MUTATION_ROLES = new Set(["owner", "admin"]);

export function createStaffMutationAuthority({ resolveIdentity, getRestId, usePostgres }) {
  if (typeof resolveIdentity !== "function" || typeof getRestId !== "function" || typeof usePostgres !== "function") {
    throw new TypeError("staff mutation authority dependencies are required");
  }
  return async function requireStaffMutationAuthority(req, res, next) {
    if (!usePostgres()) return next();
    const identity = await resolveIdentity(req);
    if (!identity?.verified) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const requestedRestId = getRestId(req);
    if (!requestedRestId || !identity.restId || identity.restId !== requestedRestId) {
      return res.status(403).json({ error: "Access Denied" });
    }
    if (!STAFF_MUTATION_ROLES.has(String(identity.role || "").toLowerCase())) {
      return res.status(403).json({ error: "Access Denied" });
    }
    req.nestaAuth = identity;
    return next();
  };
}

export function classifyStaffMutationFailure(err, isPgUnavailable) {
  return isPgUnavailable(err)
    ? { status: 503, body: { error: "PG_UNAVAILABLE" } }
    : { status: 500, body: { error: "Internal server error" } };
}
