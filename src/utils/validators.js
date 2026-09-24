// src/utils/validators.js — shared zod schemas used by the validate() middleware.
//
// Section 37 (V2): schemas deliberately do NOT declare clientId, userId,
// or role (for public-facing registration) as accepted fields. zod's
// object() strips unknown keys by default (not `.strict()`, which would
// reject the request instead) — either way, req.body is REPLACED with
// only the parsed/declared fields in middlewares/validate.js, so a
// smuggled `clientId`/`role` in the raw request body never survives past
// validation. clientContext.js additionally deletes those keys as a
// second, independent layer of defense.

import { z } from 'zod';

export const schemas = {
  // Self-service signup: creates a brand-new Client + its first
  // CLIENT_OWNER user in one call. This is the ONLY path that creates a
  // Client from an unauthenticated request — it deliberately cannot set
  // a role (CLIENT_OWNER is implied) or attach to an existing clientId.
  signup: z.object({
    clientName: z.string().min(1),
    ownerName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(8),
  }),

  login: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),

  changePassword: z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  }),

  updateProfile: z.object({
    name: z.string().min(1).optional(),
    phone: z.string().optional(),
  }),

  // Creates an ADDITIONAL staff member for the CALLER's own client (see
  // clientContext.js — clientId always comes from the authenticated
  // session, never this body). Role is restricted to STAFF/CLIENT_ADMIN;
  // CLIENT_OWNER and SUPER_ADMIN can never be granted through this path.
  createStaff: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(8),
    role: z.enum(['STAFF', 'CLIENT_ADMIN']).default('STAFF'),
    estateIds: z.array(z.string()).optional(),
  }),

  // Deliberately excludes passwordHash, role, clientId, isActive (has its
  // own dedicated deactivate endpoint), and lastLoginAt — none of those
  // should ever be settable through a generic "update this staff member"
  // request body.
  updateStaff: z.object({
    name: z.string().min(1).optional(),
    phone: z.string().optional(),
    estateIds: z.array(z.string()).optional(),
  }),

  createHouse: z.object({
    houseTypeId: z.string().min(1).optional(),
    // estateId is required in the body now that a Client can own several
    // estates — it's still checked against the caller's permitted
    // estates by clientContext.js, never trusted blindly.
    estateId: z.string().min(1),
    houseNumber: z.string().min(1),
    // Optional when houseTypeId supplies defaultRentCents; service falls back.
    monthlyRent: z.coerce.number().min(0).optional(),
    dueDay: z.coerce.number().int().min(1).max(31).optional(),
    paymentReferences: z.array(z.string().min(1)).optional(),
  }),

  // Deliberately excludes estateId/tenantId/clientId: moving a house
  // between estates, or assigning/clearing its tenant, are relationship
  // changes with their own validation (see tenantService.moveToHouse and
  // the dedicated tenant "move" flow) — not a free-form PATCH.
  updateHouse: z.object({
    houseTypeId: z.string().min(1).nullable().optional(),
    houseNumber: z.string().min(1).optional(),
    monthlyRent: z.number().positive().optional(),
    dueDay: z.number().int().min(1).max(31).optional(),
    status: z.enum(['occupied', 'vacant']).optional(),
    isActive: z.boolean().optional(),
    paymentReferences: z.array(z.string().min(1)).optional(),
  }),

  createTenant: z.object({
    name: z.string().min(1),
    phone: z.string().min(7),
    houseId: z.string().min(1),
    moveInDate: z.string().optional(),
  }),

  // No houseId here — moving a tenant between houses is a relationship
  // change (old house must be vacated, new house must belong to the same
  // client) handled by tenantService.moveToHouse, not a raw field update.
  updateTenant: z.object({
    name: z.string().min(1).optional(),
    phone: z.string().min(7).optional(),
    status: z.enum(['active', 'moved_out']).optional(),
    moveOutDate: z.string().optional(),
  }),

  moveTenant: z.object({
    houseId: z.string().min(1),
  }),

  connectBankAccount: z.object({
    estateId: z.string().min(1),
    provider: z.enum(['COOP', 'KCB', 'EQUITY', 'NCBA']),
    accountNumber: z.string().min(4),
    accountName: z.string().min(1),
    currency: z.string().optional(),
  }),

  sendSms: z
    .object({
      message: z.string().min(1).max(1000),
      tenantId: z.string().min(1).optional(),
      houseId: z.string().min(1).optional(),
      forceResend: z.boolean().optional(),
    })
    .refine((d) => Boolean(d.tenantId || d.houseId), {
      message: 'tenantId or houseId is required',
      path: ['tenantId'],
    }),

  assignTransaction: z.object({
    houseId: z.string().min(1),
  }),

  dateRange: z.object({
    startDate: z.string(),
    endDate: z.string(),
  }),
};
