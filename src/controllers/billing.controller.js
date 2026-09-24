import { rentService } from '../services/rent.service.js';
import { apiResponse } from '../utils/apiResponse.js';
import { audit } from '../services/audit.service.js';

export const billingController = {
  async generate(req, res, next) {
    try {
      const result = await rentService.generateForClient(req.clientId, {
        estateId: req.body?.estateId || req.query?.estateId || null,
        period: req.body?.period || req.query?.period || null,
        estateFilter: req.estateFilter,
      });
      await audit({
        clientId: req.clientId,
        userId: req.currentUser?._id,
        action: 'BILL_GENERATED',
        resource: 'RentCharge',
        description: `Generated ${result.created} charges for period ${result.period}`,
        metadata: result,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, result, 'Billing generation complete');
    } catch (err) {
      next(err);
    }
  },

  async houseAccount(req, res, next) {
    try {
      const account = await rentService.houseAccount(
        req.clientId,
        req.params.houseId,
        req.estateFilter
      );
      apiResponse.success(res, account);
    } catch (err) {
      next(err);
    }
  },
};
