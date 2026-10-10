const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

function getConfiguration() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
    const error = new Error('Phone sign-in is not configured.');
    error.code = 'TWILIO_NOT_CONFIGURED';
    throw error;
  }
  return { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, serviceSid: TWILIO_VERIFY_SERVICE_SID };
}

function validatePhoneNumber(value) {
  const phone = typeof value === 'string' ? value.trim() : '';
  if (!PHONE_PATTERN.test(phone)) {
    const error = new Error('Enter a valid phone number with country code, such as +14155552671.');
    error.code = 'INVALID_PHONE';
    throw error;
  }
  return phone;
}

async function twilioRequest(action, params) {
  const { accountSid, authToken, serviceSid } = getConfiguration();
  const endpoint = `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}/${action}`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('The phone verification provider rejected the request.');
    error.code = 'TWILIO_REJECTED';
    error.providerStatus = response.status;
    error.providerCode = result.code;
    throw error;
  }
  return result;
}

async function sendVerification(phone) {
  const phoneNumber = validatePhoneNumber(phone);
  await twilioRequest('Verifications', { To: phoneNumber, Channel: 'sms' });
}

async function checkVerification(phone, code) {
  const phoneNumber = validatePhoneNumber(phone);
  if (typeof code !== 'string' || !/^\d{4,10}$/.test(code.trim())) {
    const error = new Error('Enter the verification code from the text message.');
    error.code = 'INVALID_OTP';
    throw error;
  }
  const result = await twilioRequest('VerificationCheck', {
    To: phoneNumber,
    Code: code.trim()
  });
  return result.status === 'approved';
}

module.exports = {
  checkVerification,
  sendVerification,
  validatePhoneNumber
};
