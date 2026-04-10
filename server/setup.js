const fs = require('fs');
const twilio = require('twilio');

const accountSid = 'AC226036021d836580ccbe43f66f93482e';
const authToken = '9a4c85ea35f8baab9b40f75efd98ac64';
const phoneNumber = '+14085169275';

const client = twilio(accountSid, authToken);

async function setup() {
  try {
    console.log('Creating TwiML App...');
    const app = await client.applications.create({
      friendlyName: 'SMS Twilio Sender Calling App',
      voiceMethod: 'POST',
      voiceUrl: 'https://demo.twilio.com/welcome/voice/' // temporary placeholder
    });
    console.log('TwiML App created! SID:', app.sid);

    console.log('Creating API Key for browser web calling...');
    const key = await client.newKeys.create({ friendlyName: 'Desktop Caller Voice API Key' });
    console.log('API Key created! SID:', key.sid);

    const envContent = `TWILIO_ACCOUNT_SID=${accountSid}
TWILIO_AUTH_TOKEN=${authToken}
TWILIO_PHONE_NUMBER=${phoneNumber}
TWILIO_TWIML_APP_SID=${app.sid}
TWILIO_API_KEY=${key.sid}
TWILIO_API_SECRET=${key.secret}

# Ports
PORT=8142
FRONTEND_PORT=8143
`;

    // Writing to root directory
    fs.writeFileSync('../.env', envContent);
    console.log('Successfully wrote comprehensive .env configuration file!');
  } catch (error) {
    console.error('Error during setup:', error);
  }
}

setup();
