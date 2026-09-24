// src/utils/apiResponse.js — consistent API response shape (section 29 of
// the concept paper). The frontend should never need to parse arbitrary
// per-controller error formats.

export const apiResponse = {
  success(res, data = {}, message = 'OK', status = 200) {
    return res.status(status).json({ success: true, data, message });
  },
  error(res, code, message, status = 400, details) {
    return res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
  },
};
