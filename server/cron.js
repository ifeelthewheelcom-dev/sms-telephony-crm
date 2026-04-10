const cron = require('node-cron');
const db = require('./db');

let twilioClient;

function startSequenceEngine() {
    process.stdout.write('\n⏳ Starting Supabase Cron Sequence Engine (Runs every 1 minute)\n');
    
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    cron.schedule('* * * * *', async () => {
        // Fetch active leads that are due
        const { data: pendingLeads, error } = await db
            .from('campaign_leads_status')
            .select(`
                id, campaign_id, contact_id, current_step_order, next_execution_time,
                campaigns ( id, sender_pool, drip_rate, user_id )
            `)
            .eq('status', 'active')
            .lte('next_execution_time', new Date().toISOString());
            
        if (error || !pendingLeads || pendingLeads.length === 0) return;

        const campGroups = {};
        for (const lead of pendingLeads) {
            if (!lead.campaigns) continue;
            
            // Get the specific campaign step content
            const { data: step } = await db
                .from('campaign_steps')
                .select('content, delay_minutes')
                .eq('campaign_id', lead.campaign_id)
                .eq('step_order', lead.current_step_order)
                .single();
                
            if (!step) continue;
            lead.content = step.content;
            lead.delay_minutes = step.delay_minutes;
            
            const cid = lead.campaign_id;
            if (!campGroups[cid]) campGroups[cid] = [];
            campGroups[cid].push(lead);
        }

        // Process by campaign groups to respect drip rate
        for (const cid of Object.keys(campGroups)) {
            let group = campGroups[cid];
            let dripRate = group[0].campaigns.drip_rate;
            if (group.length > 0 && dripRate > 0) {
                group = group.slice(0, dripRate);
            }
            for (const lead of group) {
                await executeStepForLead(lead);
            }
        }
    });
}

async function executeStepForLead(lead) {
    try {
        const { data: contact } = await db.from('contacts').select('*').eq('id', lead.contact_id).single();
        if (!contact) return;
        
        let senderNum = contact.assigned_sender_number;
        
        // If not stickied, try pulling from campaign pool
        if (!senderNum && lead.campaigns?.sender_pool) {
            try {
                const pool = lead.campaigns.sender_pool;
                if (pool && pool.length > 0) {
                    senderNum = pool[Math.floor(Math.random() * pool.length)];
                    await db.from('contacts').update({ assigned_sender_number: senderNum }).eq('id', lead.contact_id);
                }
            } catch(e) {}
        }
        if (!senderNum) senderNum = process.env.TWILIO_PHONE_NUMBER; 
        
        let finalContent = lead.content;
        if (contact.custom_variables) {
            try {
                const vars = typeof contact.custom_variables === 'string' ? JSON.parse(contact.custom_variables) : contact.custom_variables;
                finalContent = finalContent.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, p1) => {
                    return vars[p1] !== undefined ? vars[p1] : match;
                });
            } catch(e) {}
        }

        // Execute Twilio API
        const msg = await twilioClient.messages.create({
            body: finalContent,
            from: senderNum,
            to: contact.phone_number
        });

        // Insert Outbound SMS to thread
        await db.from('messages').insert({
            user_id: lead.campaigns.user_id,
            contact_id: lead.contact_id,
            direction: 'outbound',
            type: 'sms',
            content: finalContent,
            status: msg.status
        });
        
        await queueNextStep(lead);
        
    } catch (err) {
        console.error("Cron Twilio Error sending to Lead " + lead.contact_id + ":", err.message);
    }
}

async function queueNextStep(lead) {
    const nextOrder = lead.current_step_order + 1;
    const { data: nextStep } = await db.from('campaign_steps').select('*').eq('campaign_id', lead.campaign_id).eq('step_order', nextOrder).single();
    
    if (!nextStep) {
        await db.from('campaign_leads_status').update({ status: 'finished' }).eq('id', lead.id);
    } else {
        const nextTime = new Date();
        nextTime.setMinutes(nextTime.getMinutes() + (nextStep.delay_minutes || 0));
        
        await db.from('campaign_leads_status').update({
            current_step_order: nextOrder,
            next_execution_time: nextTime.toISOString()
        }).eq('id', lead.id);
    }
}

module.exports = { startSequenceEngine };
