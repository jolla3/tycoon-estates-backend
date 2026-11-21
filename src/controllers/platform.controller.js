// src/controllers/platform.controller.js
// SUPER_ADMIN-only platform control plane. Authorization is enforced on
// the route layer (authorize('SUPER_ADMIN')); this controller assumes it.

import { platformService } from '../services/platform.service.js';
import { platformMpesaProfileService } from '../services/platformMpesaProfile.service.js';
import { mpesaRegistrationService } from '../services/mpesa/mpesaRegistration.service.js';
import { mpesaReferenceService } from '../services/mpesa/mpesaReference.service.js';
import { apiResponse } from '../utils/apiResponse.js';

function meta(req) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export const platformController = {
  async overview(req, res, next) {
    try {
      apiResponse.success(res, await platformService.overview());
    } catch (err) {
      next(err);
    }
  },

  async health(req, res, next) {
    try {
      apiResponse.success(res, await platformService.systemHealth());
    } catch (err) {
      next(err);
    }
  },

  async listClients(req, res, next) {
    try {
      apiResponse.success(res, await platformService.listClients(req.query));
    } catch (err) {
      next(err);
    }
  },

  async getClient(req, res, next) {
    try {
      apiResponse.success(res, await platformService.getClient(req.params.clientId));
    } catch (err) {
      next(err);
    }
  },

  async provisionClient(req, res, next) {
    try {
      const result = await platformService.provisionClient(req.body, req.currentUser, meta(req));
      apiResponse.success(res, result, 'Client provisioned', 201);
    } catch (err) {
      next(err);
    }
  },

  async updateClient(req, res, next) {
    try {
      const client = await platformService.updateClient(
        req.params.clientId,
        req.body,
        req.currentUser,
        meta(req)
      );
      apiResponse.success(res, client, 'Client updated');
    } catch (err) {
      next(err);
    }
  },

  async updateClientSubscription(req, res, next) {
    try {
      const sub = await platformService.updateClientSubscription(
        req.params.clientId, req.body, req.currentUser, meta(req)
      );
      apiResponse.success(res, sub, 'Subscription updated');
    } catch (err) {
      next(err);
    }
  },

  async entitlementInventory(req, res, next) {
    try {
      apiResponse.success(res, await platformService.entitlementInventory(req.query));
    } catch (err) {
      next(err);
    }
  },

  async activateClient(req, res, next) {
    try {
      const client = await platformService.activateClient(
        req.params.clientId,
        req.currentUser,
        meta(req)
      );
      apiResponse.success(res, client, 'Client activated');
    } catch (err) {
      next(err);
    }
  },

  async deactivateClient(req, res, next) {
    try {
      const client = await platformService.deactivateClient(
        req.params.clientId,
        req.currentUser,
        meta(req)
      );
      apiResponse.success(res, client, 'Client deactivated');
    } catch (err) {
      next(err);
    }
  },

  async listUsers(req, res, next) {
    try {
      const isActive =
        req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined;
      apiResponse.success(
        res,
        await platformService.listUsers({
          page: parseInt(req.query.page || '1', 10),
          limit: parseInt(req.query.limit || '50', 10),
          role: req.query.role,
          clientId: req.query.clientId,
          isActive,
        })
      );
    } catch (err) {
      next(err);
    }
  },

  async listAudit(req, res, next) {
    try {
      apiResponse.success(res, await platformService.listAudit(req.query));
    } catch (err) {
      next(err);
    }
  },

  async bankingIntegrations(req, res, next) {
    try {
      apiResponse.success(res, await platformService.listBankingIntegrations(req.query));
    } catch (err) {
      next(err);
    }
  },

  async mpesaIntegrations(req, res, next) {
    try {
      apiResponse.success(res, await platformService.listMpesaIntegrations(req.query));
    } catch (err) {
      next(err);
    }
  },

  async createMpesaProfile(req, res, next) {
    try {
      const profile = await platformMpesaProfileService.create(
        req.params.clientId, req.body, req.currentUser, meta(req)
      );
      apiResponse.success(res, profile, 'M-PESA merchant profile created in draft state', 201);
    } catch (err) {
      next(err);
    }
  },

  async mpesaCallbackConfig(req, res, next) {
    try { apiResponse.success(res, platformMpesaProfileService.callbackConfig()); } catch (err) { next(err); }
  },

  async getMpesaProfile(req, res, next) {
    try { apiResponse.success(res, await platformMpesaProfileService.get(req.params.clientId, req.params.profileId)); } catch (err) { next(err); }
  },

  async mapMpesaEstate(req, res, next) {
    try {
      apiResponse.success(res, await platformMpesaProfileService.addEstate(
        req.params.clientId, req.params.profileId, req.body.estateId, req.currentUser, meta(req)));
    } catch (err) { next(err); }
  },

  async unmapMpesaEstate(req, res, next) {
    try {
      apiResponse.success(res, await platformMpesaProfileService.removeEstate(
        req.params.clientId, req.params.profileId, req.params.estateId, req.currentUser, meta(req)));
    } catch (err) { next(err); }
  },

  async setMpesaPullNumber(req, res, next) {
    try {
      apiResponse.success(res, await platformMpesaProfileService.setPullNominatedNumber(
        req.params.clientId, req.params.profileId, req.body.msisdn, req.currentUser, meta(req)));
    } catch (err) { next(err); }
  },

  async registerMpesaC2b(req, res, next) {
    try {
      apiResponse.success(res, await mpesaRegistrationService.registerC2b({
        clientId: req.params.clientId, profileId: req.params.profileId, actor: req.currentUser, reqMeta: meta(req) }));
    } catch (err) { next(err); }
  },

  async registerMpesaPull(req, res, next) {
    try {
      apiResponse.success(res, await mpesaRegistrationService.registerPull({
        clientId: req.params.clientId, profileId: req.params.profileId, actor: req.currentUser, reqMeta: meta(req) }));
    } catch (err) { next(err); }
  },

  async reconcileMpesaRegistration(req, res, next) {
    try {
      apiResponse.success(res, await mpesaRegistrationService.reconcile({
        clientId: req.params.clientId, profileId: req.params.profileId, kind: req.params.kind,
        outcome: req.body.outcome, actor: req.currentUser, reqMeta: meta(req) }));
    } catch (err) { next(err); }
  },

  async listMpesaReferences(req, res, next) {
    try {
      apiResponse.success(res, await mpesaReferenceService.list({
        clientId: req.params.clientId, merchantProfileId: req.params.profileId, query: req.query }));
    } catch (err) { next(err); }
  },

  async issueMpesaReference(req, res, next) {
    try {
      const { reference, created } = await mpesaReferenceService.issue({
        clientId: req.params.clientId, merchantProfileId: req.params.profileId,
        tenancyId: req.body.tenancyId, actor: req.currentUser, reqMeta: meta(req) });
      apiResponse.success(res, mpesaReferenceService.toView(reference), created ? 'Reference issued' : 'Active reference already exists', created ? 201 : 200);
    } catch (err) { next(err); }
  },

  async retireMpesaReference(req, res, next) {
    try {
      const row = await mpesaReferenceService.retire({
        clientId: req.params.clientId, referenceId: req.params.referenceId, reason: 'ADMIN',
        actor: req.currentUser, reqMeta: meta(req) });
      apiResponse.success(res, mpesaReferenceService.toView(row));
    } catch (err) { next(err); }
  },

  async clientDiagnostics(req, res, next) {
    try {
      apiResponse.success(res, await platformService.clientDiagnostics(req.params.clientId));
    } catch (err) {
      next(err);
    }
  },

  async listSubscriptions(req, res, next) {
    try {
      apiResponse.success(
        res,
        await platformService.listSubscriptions({
          page: parseInt(req.query.page || '1', 10),
          limit: parseInt(req.query.limit || '50', 10),
          status: req.query.status,
        })
      );
    } catch (err) {
      next(err);
    }
  },
};
