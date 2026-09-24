// src/services/auth.service.js
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { Client } from '../models/Client.js';
import { Estate } from '../models/Estate.js';
import { Subscription } from '../models/Subscription.js';
import { Errors } from '../utils/errors.js';

const SALT_ROUNDS = 12;

export const authService = {
  /**
   * Self-service signup — the only path that creates a new Client. Always
   * creates exactly one CLIENT_OWNER for it; there is no way to pass a
   * role here (see utils/validators.js#signup).
   */
  async signup({ clientName, ownerName, email, phone, password }) {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throw Errors.Conflict('A user with this email already exists');

    const client = await Client.create({ name: clientName });
    try {
      await Subscription.create({ clientId: client._id, plan: 'trial', status: 'active' });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const owner = await User.create({
      name: ownerName,
      email: email.toLowerCase(),
      phone,
      passwordHash,
      role: 'CLIENT_OWNER',
      clientId: client._id,
    });

    return { client, owner };
  },

  /**
   * Adds a STAFF/CLIENT_ADMIN user to an EXISTING client — clientId comes
   * from the caller's own authenticated context (req.clientId), never
   * from this payload, and role is pre-restricted by
   * utils/validators.js#createStaff to STAFF/CLIENT_ADMIN only.
   */
  async createStaff(clientId, { name, email, phone, password, role, estateIds }) {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throw Errors.Conflict('A user with this email already exists');

    // A CLIENT_ADMIN submitting an estateId from a DIFFERENT client must
    // never silently succeed — that would let Client A grant a staff
    // member access to Client B's estate just by guessing/knowing its id.
    if (estateIds?.length) {
      const validCount = await Estate.countDocuments({ _id: { $in: estateIds }, clientId });
      if (validCount !== estateIds.length) {
        throw Errors.InvalidRequest('One or more estateIds do not belong to your client');
      }
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    return User.create({ name, email: email.toLowerCase(), phone, passwordHash, role, clientId, estateIds });
  },

  /** Field set is pre-restricted by utils/validators.js#updateStaff — no passwordHash/role/clientId/isActive can arrive here. */
  async updateStaff(clientId, userId, updates) {
    if (updates.estateIds?.length) {
      const validCount = await Estate.countDocuments({ _id: { $in: updates.estateIds }, clientId });
      if (validCount !== updates.estateIds.length) {
        throw Errors.InvalidRequest('One or more estateIds do not belong to your client');
      }
    }

    const staff = await User.findOneAndUpdate({ _id: userId, clientId }, updates, { new: true }).select('-passwordHash');
    if (!staff) throw Errors.AuthRequired('Staff member not found in your client');
    return staff;
  },

  async login(email, password) {
    const user = await User.findOne({ email: email.toLowerCase(), isActive: true });
    if (!user) throw Errors.InvalidCredentials();

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw Errors.InvalidCredentials();

    user.lastLoginAt = new Date();
    await user.save();
    return user;
  },

  async getById(userId) {
    const user = await User.findById(userId);
    if (!user) throw Errors.AuthRequired('Session user no longer exists');
    return user;
  },
};
