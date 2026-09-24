// src/middlewares/validate.js — zod-schema request validation (section 23/24).
import { apiResponse } from '../utils/apiResponse.js';

export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return apiResponse.error(res, 'INVALID_REQUEST', 'Request validation failed', 422, details);
    }
    req[source] = result.data;
    next();
  };
}
