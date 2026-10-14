import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { pool } from "./db.js";

// API keys are high-entropy random strings (not user-chosen passwords), so a fast hash is appropriate here —
// unlike bcrypt for login passwords, there's no brute-force risk worth the per-request cost of a slow hash
export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// shared by the admin-page issuance endpoint and scripts/create-api-client.ts, so both mint keys the same way
export function generateApiKey(): string {
  return `gt_live_${crypto.randomBytes(32).toString("base64url")}`;
}

export interface ApiClient {
  id: number;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiClient?: ApiClient;
    }
  }
}

// 3rd-party-facing endpoints authenticate via `Authorization: Bearer <key>` (or `X-Api-Key: <key>`), never the
// admin UI's session cookie — separate trust boundary, separate credential lifecycle (see scripts/create-api-client.ts)
export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const rawKey = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : (req.header("x-api-key") ?? "").trim();
  if (!rawKey) return res.status(401).json({ error: "Missing API key" });
  try {
    const { rows } = await pool.query(
      `UPDATE api_clients SET last_used_at = now() WHERE key_hash = $1 AND active = true RETURNING id, name`,
      [hashApiKey(rawKey)]
    );
    if (!rows.length) return res.status(401).json({ error: "Invalid or inactive API key" });
    req.apiClient = { id: rows[0].id, name: rows[0].name };
    next();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
