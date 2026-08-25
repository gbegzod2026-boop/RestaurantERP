/** Phase 2 data-backend flag. Default firebase so existing deploys stay on RTDB. */
export function getDataBackend() {
  const raw = String(process.env.DATA_BACKEND || "firebase").trim().toLowerCase();
  return raw === "postgres" || raw === "postgresql" || raw === "pg" ? "postgres" : "firebase";
}

export function usePostgres() {
  return getDataBackend() === "postgres";
}
