const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { verifyHomepageSSOToken } = require('../lib/sso');

const secret = 'test-shared-secret';
const userId = '507f1f77bcf86cd799439011';

function signToken(payload) {
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
    return encodedPayload + '.' + signature;
}

test('verifies a valid Homepage SSO token', () => {
    const now = Date.now();
    const token = signToken({ userId, name: 'Serenity User', exp: now + 60_000 });

    assert.equal(verifyHomepageSSOToken(token, secret, now).userId, userId);
});

test('rejects expired tokens', () => {
    const now = Date.now();
    const token = signToken({ userId, name: 'Serenity User', exp: now });

    assert.equal(verifyHomepageSSOToken(token, secret, now), null);
});

test('rejects a token with a modified signature', () => {
    const token = signToken({ userId, name: 'Serenity User', exp: Date.now() + 60_000 });

    assert.equal(verifyHomepageSSOToken(token + 'x', secret), null);
});

test('rejects tokens with malformed or non-ObjectId user IDs', () => {
    const token = signToken({ userId: 'not-an-object-id', exp: Date.now() + 60_000 });

    assert.equal(verifyHomepageSSOToken(token, secret), null);
});