// src/services/profile.service.js
//
// Section 5: the authenticated user's own profile — split out from
// auth.service.js (which now stays focused on signup/login/staff
// management) so this isn't a dumping ground for every human-related
// database operation. Every function here operates ONLY on the
// caller-supplied userId, which controllers must always source from
// req.currentUser._id, never from a request parameter.
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { Errors } from '../utils/errors.js';

const SALT_ROUNDS = 12;

export const profileService = {
  async changePassword(userId, currentPassword, newPassword) {
    const user = await User.findById(userId);
    if (!user) throw Errors.AuthRequired('Session user no longer exists');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw Errors.InvalidCredentials('Current password is incorrect');

    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await user.save();
    return user;
  },

  /** Field set is pre-restricted by utils/validators.js#updateProfile (name/phone only). */
  async update(userId, updates) {
    const user = await User.findByIdAndUpdate(userId, updates, { new: true });
    if (!user) throw Errors.AuthRequired('Session user no longer exists');
    return user;
  },
};
