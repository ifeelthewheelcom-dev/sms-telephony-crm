require('dotenv').config({ path: '../.env' });
const { exec } = require('child_process');
const twilio = require('twilio');
const ngrok = require('@ngrok/ngrok');

const PORT = process.env.PORT || 8142;
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;

const client = twilio(accountSid, authToken);

async function start() {
    console.log('🟢 Starting Express server...');
    const serverProcess = exec(`node index.js`);
    serverProcess.stdout.pipe(process.stdout);
    serverProcess.stderr.pipe(process.stderr);

    try {
        let url;
        
        if (process.env.NODE_ENV === 'production') {
             url = process.env.PROD_URL;
             if (!url) {
                 console.log('⚠️ PROD_URL is missing! Webhooks will not be instantly updated. Add it to Render.');
             }
        } else {
             console.log(`\n⏳ Opening Ngrok tunnel on port ${PORT}...`);
             const listener = await ngrok.forward({ addr: PORT, authtoken: '3C5Q3QPe5kaf6M3K6KQD6hEaefg_7mcJJt1ir6rNDEr6YNsXH' });
             url = listener.url();
             console.log(`=> Ngrok Tunnel established: ${url}`);
        }

        if (url) {
            console.log('\n⚙️  Updating Twilio Phone Number Webhooks...');
            const incomingPhones = await client.incomingPhoneNumbers.list();
            let updatedCount = 0;
            for (const phone of incomingPhones) {
                await client.incomingPhoneNumbers(phone.sid).update({
                    smsUrl: `${url}/api/webhooks/incoming-sms`,
                    voiceUrl: `${url}/api/webhooks/incoming-call`
                });
                updatedCount++;
                console.log(`✅ Webhook updated for: ${phone.phoneNumber}`);
            }
            if (updatedCount === 0) {
                console.log('⚠️ Could not find any Twilio Phone Numbers in your account.');
            }

            console.log('\n⚙️  Updating TwiML App Webhooks for outbound dialing...');
            if (twimlAppSid) {
                await client.applications(twimlAppSid).update({
                    voiceUrl: `${url}/api/webhooks/outbound-call`,
                    voiceMethod: 'POST'
                });
                console.log('✅ Twilio TwiML App voice webhook successfully mapped to the cloud!');
            }
        }

        console.log('\n======================================================');
        console.log('🚀 SYSTEM READY!');
        console.log('Your SMS & Calling WebApp is fully connected to Twilio.');
        console.log('======================================================\n');
        
        // Keep the NodeJS process alive indefinitely so the Ngrok tunnel doesn't magically close!
        process.stdin.resume();
        
    } catch(err) {
        console.error('Error setting up tunnel or Twilio:', err);
    }
}

start();
