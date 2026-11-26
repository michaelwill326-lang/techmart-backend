const axios = require("axios");
require("dotenv").config();



const TERMII_API_KEY = process.env.TERMII_API_KEY;
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID || 'TechMart';
const TERMII_BASE_URL = 'https://api.ng.termii.com';

const sendOrderUpdate = async (to, customerName, orderId, status) => {
  if (!TERMII_API_KEY) {
    console.log(`⚠️ Termii API Key missing. Alert simulated for ${customerName}: Order ${orderId} is now ${status}.`);
    return;
  }

  let formattedPhone = to.trim().replace('+', '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '234' + formattedPhone.substring(1);
  }

  let statusMessage = '';
  switch(status.toLowerCase()) {
    case 'dispatched':
      statusMessage = 'has been packaged and has departed our central fulfillment hub';
      break;
    case 'out for delivery':
      statusMessage = 'is currently with an internal TechMart logistics rider and is on its way to your address';
      break;
    case 'delivered':
      statusMessage = 'has been successfully delivered and verified by our agent. Thank you for shopping with TechMart!';
      break;
    default:
      statusMessage = `status has been updated to: ${status}`;
  }

  const messageText = `Hello ${customerName}, your TechMart order #${orderId.slice(-6).toUpperCase()} ${statusMessage}. Track live on your dashboard.`;

  const payload = {
    to: formattedPhone,
    from: TERMII_SENDER_ID,
    sms: messageText,
    type: "plain",
    channel: "generic"
  };

  try {
    const response = await axios.post(`${TERMII_BASE_URL}/api/sms/send`, {
      api_key: TERMII_API_KEY,
      ...payload
    });

    if (response.data && response.data.message === "Successfully Sent") {
      console.log(`📱 Termii SMS alert sent successfully to ${formattedPhone}! Message ID: ${response.data.message_id}`);
    } else {
      console.warn(`⚠️ Termii API accepted request but returned unexpected response:`, response.data);
    }
  } catch (error) {

    console.error("❌ Termii Status:", error.response?.status);
    console.error("❌ Termii Headers:", error.response?.headers);
    console.error("❌ Termii Body:", error.response?.data);
    console.error("❌ Axios Error:", error.message);

  }
};


const sendWalletPinResetOTP = async (to, customerName, otp) => {
  if (!TERMII_API_KEY) {
    console.log(`⚠️ Wallet PIN OTP for ${customerName}: ${otp}`);
    return;
  }

  let formattedPhone = to.trim().replace("+", "");

  if (formattedPhone.startsWith("0")) {
    formattedPhone = "234" + formattedPhone.substring(1);
  }

  const messageText =
    `TechMart Wallet\n\n` +
    `Hi ${customerName},\n` +
    `Your Wallet PIN reset code is ${otp}.\n\n` +
    `This code expires in 10 minutes.`;

  try {
    const response = await axios.post(
      `${TERMII_BASE_URL}/api/sms/send`,
      {
        api_key: TERMII_API_KEY,
        to: formattedPhone,
        from: TERMII_SENDER_ID,
        sms: messageText,
        type: "plain",
        channel: "generic"
      }
    );

    console.log("📱 Wallet PIN SMS:", response.data);

    return {
      success: true,
      provider: "Termii",
      response: response.data
    };

  } catch (err) {

    console.error(
      "❌ Wallet PIN SMS failed:",
      err.response?.data || err.message
    );

    return {
      success: false,
      provider: "Termii",
      error: err.response?.data || err.message
    };
  }
};


module.exports = {
  sendOrderUpdate,
  sendWalletPinResetOTP,
};
