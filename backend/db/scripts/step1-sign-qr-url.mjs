import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signQrParams } from "../../security/qrSign.js";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(backendDir, ".env") });

const restId = "rest_1999000000001";
const table = "1";
const { sig, exp } = signQrParams({ restId, table, tableId: "" });
process.stdout.write(`http://127.0.0.1:4000/client.html?restId=${restId}&table=${table}&sig=${encodeURIComponent(sig)}&exp=${encodeURIComponent(exp)}\n`);
