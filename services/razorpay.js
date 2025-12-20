const Razorpay = require('razorpay');
const crypto = require('crypto');

const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('[Razorpay] Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET environment variables. Payment APIs will fail.');
}

const razorpayClient = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    })
  : null;

const assertClient = () => {
  if (!razorpayClient) {
    const error = new Error('Razorpay is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    error.code = 'RAZORPAY_NOT_CONFIGURED';
    throw error;
  }
};

/**
 * Creates a Razorpay order
 * @param {object} params
 * @param {number|string} params.amount - Amount in currency units (e.g., rupees)
 * @param {string} [params.currency='INR']
 * @param {object} [params.metadata={}]
 */
const createOrder = async ({ amount, currency = 'INR', metadata = {} }) => {
  assertClient();

  const amountInPaise = Math.round(Number(amount) * 100);
  if (Number.isNaN(amountInPaise) || amountInPaise <= 0) {
    const error = new Error('Invalid amount provided for Razorpay order');
    error.code = 'INVALID_AMOUNT';
    throw error;
  }

  const order = await razorpayClient.orders.create({
    amount: amountInPaise,
    currency,
    notes: metadata
  });

  return order;
};

/**
 * Verifies Razorpay signature from payment capture webhook/client confirmation
 * @param {object} params
 * @param {string} params.orderId
 * @param {string} params.paymentId
 * @param {string} params.signature
 */
const verifySignature = ({ orderId, paymentId, signature }) => {
  assertClient();

  const body = `${orderId}|${paymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  return expectedSignature === signature;
};

module.exports = {
  createOrder,
  verifySignature
};

