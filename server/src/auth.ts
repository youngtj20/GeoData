import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { pool } from "./db.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — add it to server/.env.local`);
  return value;
}

const JWT_SECRET: string = requireEnv("JWT_SECRET");

const COOKIE_NAME = "gt_session";
const TOKEN_TTL = "7d";

export interface AuthedUser {
  id: number;
  username: string;
  permissions: string[];
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME);
}

async function loadUser(userId: number): Promise<AuthedUser | null> {
  const { rows } = await pool.query(`SELECT id, username FROM users WHERE id = $1`, [userId]);
  if (!rows.length) return null;
  const { rows: permRows } = await pool.query(
    `SELECT p.key FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = $1`,
    [userId]
  );
  return { id: rows[0].id, username: rows[0].username, permissions: permRows.map((r) => r.key) };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

// attaches req.user if a valid session cookie is present, but never rejects — routes decide for themselves
// whether a user (or a specific permission) is required
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return next();
    const payload = jwt.verify(token, JWT_SECRET) as unknown as { sub: number };
    req.user = (await loadUser(payload.sub)) ?? undefined;
  } catch {
    // invalid/expired token — treat as logged out rather than erroring the request
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Login required" });
  next();
}

export function requirePermission(key: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Login required" });
    if (!req.user.permissions.includes(key)) return res.status(403).json({ error: `Missing permission: ${key}` });
    next();
  };
}

export { COOKIE_NAME, loadUser };
