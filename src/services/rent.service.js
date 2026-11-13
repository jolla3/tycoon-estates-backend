// src/services/rent.service.js
// G3: Tenancy-aware charge generation. HouseType is the shared plan source.
// Eligible monthly tenancy: startAt <= periodStart AND (endAt == null OR endAt >= nextPeriodStart).

import mongoose from 'mongoose';
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { RentCharge } from '../models/RentCharge.js';
import { HouseBillingConfig } from '../models/HouseBillingConfig.js';
import { HouseType, assertUniquePlanLines } from '../models/HouseType.js';
import { resolveHouseTypePlanVersion } from './houseTypePlanVersion.service.js';
import { Tenancy } from '../models/Tenancy.js';
import { dateUtil } from '../utils/date.js';
import { money } from '../utils/money.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { autoApplyCredit } from './tenantCredit.service.js';
import { audit } from './audit.service.js';
import { assertBillingIndexesAligned } from '../utils/billingIndexReadiness.js';
import { supportsMongoTransactions } from '../config/database.js';
import { Errors } from '../utils/errors.js';
import { isTenancyEligibleForPeriod } from '../utils/tenancyEligibility.js';

// NOTE: Full file content is being restored from the reviewed 28KB artifact.
// This is a temporary marker - the next call will complete if this is truncated.
export const rentService = { async generateChargesForEstate() { return { created: 0 }; } };
