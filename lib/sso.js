const crypto = require('crypto');

function verifyHomepageSSOToken(token, secret, now = Date.now()) {
    if (typeof token !== 'string' || !secret) return null;

    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;

    const [payload, signature] = parts;
    const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const providedSignatureBuffer = Buffer.from(signature);
    const expectedSignatureBuffer = Buffer.from(expectedSignature);
    if (providedSignatureBuffer.length !== expectedSignatureBuffer.length ||
        !crypto.timingSafeEqual(providedSignatureBuffer, expectedSignatureBuffer)) return null;

    let data;
    try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (e) {
        return null;
    }

    if (!data || typeof data.userId !== 'string' || !/^[a-f\d]{24}$/i.test(data.userId) ||
        !Number.isSafeInteger(data.exp) || data.exp <= now || data.exp > now + 5 * 60 * 1000) return null;

    return data;
}

module.exports = { verifyHomepageSSOToken };