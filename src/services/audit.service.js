// src/services/audit.service.js — writes client-scoped AuditLog entries
// for sensitive actions (section 24/26). Never throws into the caller's
// request path — a failed audit write should not fail the user's request,
// but it IS logged loudly so it doesn't disappear silently.
import { AuditLog } from '../models/AuditLog.js';
import { logger } from '../config/logger.js';

export async function audit({ clientId, estateId, userId, action, resource, resourceId, description, metadata, ipAddress, userAgent }) {
  try {
    await AuditLog.create({ clientId, estateId, userId, action, resource, resourceId, description, metadata, ipAddress, userAgent });
  } catch (err) {
    logger.error({ error: err.message, action, clientId: clientId ? String(clientId) : null }, 'Failed to write audit log');
  }
}

/** Client-scoped audit log query — callers MUST pass clientId; there is no "list all audit logs" path for non-SUPER_ADMIN use. */
export async function listAuditLogs(clientId, { limit = 100 } = {}) {
  return AuditLog.find({ clientId }).sort({ createdAt: -1 }).limit(limit);
}
