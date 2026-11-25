import '../setup.js';
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
const post = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: { post } }));
const { CelcomProvider, normalizeCelcomMobile } = await import('../../src/services/sms/providers/celcom/celcom.provider.js');

const provider = () => new CelcomProvider({
  smsUrl: 'https://celcom.example/api/services/sendsms/',
  partnerId: 'partner-1', apiKey: 'secret-api-key', senderId: 'ESTATE',
});

beforeEach(() => post.mockReset());

describe('Celcom SMS provider boundary', () => {
  test.each([
    ['0769563983', '254769563983'],
    ['0712345678', '254712345678'],
    ['+254769563983', '254769563983'],
    ['254769563983', '254769563983'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeCelcomMobile(input)).toBe(expected);
  });

  test('sends a locally stored Kenyan number to Celcom in international format', async () => {
    post.mockResolvedValueOnce({ data: { responses: [{ 'respose-code': 200, messageid: 12345 }] } });
    const result = await provider().send('0769563983', 'Pendo: Rent KES 9,000');
    expect(result).toMatchObject({ success: true, status: 'accepted', providerMessageId: '12345' });
    expect(post.mock.calls[0][1]).toMatchObject({ mobile: '254769563983', shortcode: 'ESTATE', pass_type: 'plain' });
  });

  test('preserves a safe provider rejection description without exposing credentials or message contents', async () => {
    const token = 'A'.repeat(43);
    const privateMessage = `Rent KES 9,000 https://pay.example.com/pay#t=${token}`;
    post.mockRejectedValueOnce({ response: {
      status: 422,
      data: { detail: 'Invalid mobile number; request rejected' },
    } });
    const result = await provider().send('0769563983', privateMessage);
    expect(result).toMatchObject({ success: false, status: 'failed', retryable: false });
    expect(result.errorMessage).toContain('HTTP 422');
    expect(result.errorMessage).toContain('Invalid mobile number');
    expect(result.errorMessage).not.toContain('secret-api-key');
    expect(result.errorMessage).not.toContain('0769563983');
    expect(result.errorMessage).not.toContain('254769563983');
    expect(result.errorMessage).not.toContain(privateMessage);
    expect(result.errorMessage).not.toContain(token);
  });

  test('does not call the provider for malformed mobile input', async () => {
    const result = await provider().send('not-a-phone', 'message');
    expect(result).toMatchObject({ success: false, status: 'failed', errorMessage: 'Invalid mobile number format' });
    expect(post).not.toHaveBeenCalled();
  });
});
