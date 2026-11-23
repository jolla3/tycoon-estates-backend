// src/services/smsTemplates.js
// SMS message templates and pure rendering helpers.

import { money } from '../utils/money.js';
import { Errors } from '../utils/errors.js';

export function formatSmsDisplayLabel(value) {
  const label = String(value ?? '').trim();
  if (!label || label !== label.toLocaleLowerCase('en-KE')) return label;
  return label.replace(/(^|[\s-])(\p{L})/gu, (_, separator, letter) =>
    separator + letter.toLocaleUpperCase('en-KE')
  );
}

export function formatRegistrationPlanText(snapshot, currency = 'KES') {
  if (!snapshot || typeof snapshot !== 'object') {
    throw Errors.InvalidRequest('Cannot render registration SMS without a billing snapshot');
  }

  const { outcome, lines } = snapshot;
  if (outcome === 'UNCONFIGURED') {
    return 'This house has no configured billing plan.';
  }
  if (outcome === 'LEGACY_UNCLASSIFIED') {
    return 'The billing plan for this house cannot currently be determined.';
  }
  if (outcome === 'NO_EFFECTIVE_HOUSE_TYPE_VERSION') {
    return 'No applicable house-type billing plan is currently effective for this house.';
  }
  if (outcome === 'HOUSE_CONFIG_NO_EFFECTIVE_ROWS') {
    return 'No effective house billing configuration lines apply at registration.';
  }
  if (outcome === 'HOUSE_CONFIG_FUTURE_ONLY') {
    return 'House billing configuration exists only for a future effective date; none applies at registration.';
  }
  if (outcome === 'VALID_EMPTY_HOUSE_TYPE_PLAN') {
    return 'The effective house-type plan has no billing lines configured.';
  }
  if (!lines?.length) {
    return 'No applicable billing plan lines are available for this house at registration.';
  }

  const lineParts = lines.map((line) => {
    const rawLabel = line.description || String(line.chargeType || 'other').replace(/[_-]+/g, ' ').toLowerCase();
    const label = formatSmsDisplayLabel(rawLabel);
    return `${label}: ${money.format(line.amountCents, currency)}`;
  });

  return `Your configured charges:\n${lineParts.join('\n')}.`;
}

const TEMPLATES = {
  rent_reminder: ({ tenantName, houseNumber, balanceCents, currency }) =>
    'Dear ' + tenantName + ', House ' + houseNumber + ' has an outstanding rent balance of ' +
      money.format(balanceCents, currency) + '. Kindly settle it at your earliest convenience.',
  rent_reminder_d5: ({
    tenantName, houseNumber, period, dueDate,
    chargeLines = [],
    previousArrearsCents, totalOutstandingCents, currency = 'KES',
  }) => {
    if (!Array.isArray(chargeLines)) {
      throw Errors.InvalidRequest('Cannot render D-5 reminder without chargeLines');
    }
    for (const [field, value] of Object.entries({
      previousArrearsCents, totalOutstandingCents,
    })) {
      requireTemplateCents(value, field);
    }
    for (const [field, value] of Object.entries({ tenantName, houseNumber, period, dueDate })) {
      if (typeof value !== 'string' || !value.trim()) {
        throw Errors.InvalidRequest('Cannot render D-5 reminder without ' + field);
      }
    }
    for (const line of chargeLines) {
      requireTemplateCents(line.outstandingCents, 'chargeLine.outstandingCents');
      if (typeof line.description !== 'string' || !line.description.trim()) {
        throw Errors.InvalidRequest('Cannot render D-5 reminder with a charge line missing description');
      }
    }
    const lineParts = chargeLines.map((line) =>
      line.description + ': ' + money.format(line.outstandingCents, currency)
    );
    return [
      'Rent due in five days on ' + dueDate + ' for ' + tenantName +
        ', House ' + houseNumber + ' (' + period + ').',
      lineParts.length ? lineParts.join('; ') + '.' : null,
      previousArrearsCents ? 'Previous arrears: ' + money.format(previousArrearsCents, currency) + '.' : null,
      'Total outstanding: ' + money.format(totalOutstandingCents, currency) + '.',
    ].filter(Boolean).join(' ');
  },
  payment_confirmation: ({ tenantName, houseNumber, amountCents, balanceCents, currency }) =>
    `Dear ${tenantName}, we have received your payment of ${money.format(amountCents, currency)} for House ${houseNumber}. Remaining balance: ${money.format(Math.max(balanceCents, 0), currency)}. Thank you.`,
  arrears_notice: ({ tenantName, houseNumber, monthsOverdue, balanceCents, currency }) =>
    `Dear ${tenantName}, House ${houseNumber} is ${monthsOverdue} month(s) in arrears, totaling ${money.format(balanceCents, currency)}. Please contact the estate office urgently.`,
  billing_notification: ({
    tenantName, houseNumber, period,
    rentOutstandingCents, waterOutstandingCents,
    electricityOutstandingCents, otherOutstandingCents,
    previousArrearsCents, paidCents, totalOutstandingCents,
    dueDate, currency = 'KES',
  }) => {
    for (const [field, value] of Object.entries({
      rentOutstandingCents, waterOutstandingCents,
      electricityOutstandingCents, otherOutstandingCents,
      previousArrearsCents, paidCents, totalOutstandingCents,
    })) {
      requireTemplateCents(value, field);
    }
    const lines = [
      'Billing statement ' + period + ' for ' + tenantName + ', House' +
        (String(houseNumber).includes(',') ? 's' : '') + ' ' + houseNumber + '.',
      rentOutstandingCents ? 'Rent outstanding: ' + money.format(rentOutstandingCents, currency) + '.' : null,
      waterOutstandingCents ? 'Water outstanding: ' + money.format(waterOutstandingCents, currency) + '.' : null,
      electricityOutstandingCents ? 'Electricity outstanding: ' + money.format(electricityOutstandingCents, currency) + '.' : null,
      otherOutstandingCents ? 'Other outstanding: ' + money.format(otherOutstandingCents, currency) + '.' : null,
      previousArrearsCents ? 'Previous arrears: ' + money.format(previousArrearsCents, currency) + '.' : null,
      paidCents ? 'Paid this period: ' + money.format(paidCents, currency) + '.' : null,
      'Total outstanding: ' + money.format(totalOutstandingCents, currency) + '.',
      dueDate ? 'Due: ' + dueDate + '.' : null,
    ].filter(Boolean);
    return lines.join(' ');
  },
};


function requireTemplateCents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    const err = Errors.InvalidRequest('Cannot render billing SMS: ' + field + ' must be a verified non-negative integer-cent value');
    err.code = 'SMS_TEMPLATE_AMOUNT_INVALID';
    throw err;
  }
  return value;
}

function prefixEstate(estateName, message) {
  const name = String(estateName || '').trim();
  const body = String(message || '').trim();
  if (!name || !body) {
    throw Errors.InvalidRequest('Estate name and SMS body are required');
  }

  const displayName = formatSmsDisplayLabel(name);
  const colonAt = body.indexOf(':');
  const existingPrefix = colonAt >= 0 ? body.slice(0, colonAt).trim() : '';
  if (existingPrefix.toLocaleLowerCase('en-KE') === name.toLocaleLowerCase('en-KE')) {
    return `${displayName}:${body.slice(colonAt + 1)}`;
  }
  return `${displayName}: ${body}`;
}

function previewSms(type, templateData) {
  const render = TEMPLATES[type];
  if (!render) throw Errors.InvalidRequest(`Unknown SMS template: ${type}`);
  return render({ currency: 'KES', ...templateData });
}

export { TEMPLATES, previewSms, requireTemplateCents, prefixEstate };
