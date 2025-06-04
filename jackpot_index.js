// jackpot_index.js - Dedicated Helper Bot for Dice Escalator Jackpot Runs

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';

// --- Environment Variable Validation & Configuration ---
console.log("HelperDEJackpot: Loading environment variables..."); // Log prefix clarifies role

const HELPER_DE_JACKPOT_BOT_TOKEN = process.env.HELPER_DE_JACKPOT_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const POLLING_INTERVAL_MS = process.env.HELPER_DEJ_DB_POLL_INTERVAL_MS ? parseInt(process.env.HELPER_DEJ_DB_POLL_INTERVAL_MS, 10) : 3000;
const MAX_SESSIONS_PER_CYCLE = process.env.HELPER_DEJ_MAX_SESSIONS_PER_CYCLE ? parseInt(process.env.HELPER_DEJ_MAX_SESSIONS_PER_CYCLE, 10) : 1;
const JACKPOT_RUN_TURN_TIMEOUT_MS = process.env.HELPER_DEJ_TURN_TIMEOUT_MS ? parseInt(process.env.HELPER_DEJ_TURN_TIMEOUT_MS, 10) : 45000;

if (!HELPER_DE_JACKPOT_BOT_TOKEN) {
    console.error("FATAL ERROR: HELPER_DE_JACKPOT_BOT_TOKEN is not defined for the HelperDEJackpot Bot.");
    process.exit(1);
}
if (!DATABASE_URL) {
    console.error("FATAL ERROR: DATABASE_URL is not defined for the HelperDEJackpot Bot.");
    process.exit(1);
}
console.log(`HelperDEJackpot: Token loaded.`);
console.log(`HelperDEJackpot: DB Polling Interval: ${POLLING_INTERVAL_MS}ms`);
console.log(`HelperDEJackpot: Max Sessions Per Cycle: ${MAX_SESSIONS_PER_CYCLE}`);
console.log(`HelperDEJackpot: Turn Timeout for Jackpot Roll: ${JACKPOT_RUN_TURN_TIMEOUT_MS}ms`);

// --- PostgreSQL Pool Initialization ---
const useSslHelper = process.env.DB_SSL === undefined ? true : (process.env.DB_SSL === 'true');
const rejectUnauthorizedSslHelper = process.env.DB_REJECT_UNAUTHORIZED === undefined ? false : (process.env.DB_REJECT_UNAUTHORIZED === 'true');

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSslHelper ? { rejectUnauthorized: rejectUnauthorizedSslHelper } : false,
});
pool.on('error', (err, client) => console.error('HelperDEJackpot: Unexpected error on idle PostgreSQL client', err));

// --- Telegram Bot Initialization ---
const bot = new TelegramBot(HELPER_DE_JACKPOT_BOT_TOKEN, { polling: true });
let botUsername = "HelperDEJackpotBot"; // Default
bot.getMe().then(me => { 
    botUsername = me.username || botUsername; 
    console.log(`HelperDEJackpot: Online as @${botUsername}`); 
}).catch(err => console.error(`HelperDEJackpot: Failed to get bot info: ${err.message}. Using default username.`));

// --- In-memory state for active jackpot sessions being managed by THIS helper instance ---
const activeHelperSessions = new Map(); // Key: session_id, Value: sessionData

// --- Helper Functions ---
function escapeHTML(text) {
    if (text === null || typeof text === 'undefined') return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatDiceRollsHTML(rollsArray) {
    if (!Array.isArray(rollsArray) || rollsArray.length === 0) return '<i>None yet</i>';
    return rollsArray.map(roll => `🎲<b>${roll}</b>`).join(' ');
}

// --- Database Polling to Pick Up New Jackpot Sessions ---
async function checkAndInitiateJackpotSessions() {
    if (isShuttingDownHelper) return;

    const activeSessionCount = activeHelperSessions.size;
    const maxConcurrentSessionsThisHelper = MAX_SESSIONS_PER_CYCLE; // How many this instance is willing to manage

    if (activeSessionCount >= maxConcurrentSessionsThisHelper) {
        // console.log(`[HelperDEJackpot_Poll] Already managing ${activeSessionCount} session(s). Max: ${maxConcurrentSessionsThisHelper}. Skipping new claims.`);
        return;
    }

    const sessionsToAttemptToClaim = maxConcurrentSessionsThisHelper - activeSessionCount;
    if (sessionsToAttemptToClaim <= 0) {
        return;
    }

    // Attempt to claim one session at a time, up to the limit we can handle
    for (let i = 0; i < sessionsToAttemptToClaim; i++) {
        if (isShuttingDownHelper) {
            console.log("[HelperDEJackpot_Poll] Shutdown detected during claim loop.");
            break;
        }

        let client = null;
        let claimedSessionData = null;
        const logPrefixCycle = `[HelperDEJackpot_PollAttempt ${i+1}/${sessionsToAttemptToClaim}]`;

        try {
            client = await pool.connect(); // Acquire a client for this attempt
            await client.query('BEGIN');

            // Select and lock ONE available session for this specific helper type
            const selectRes = await client.query(
                `SELECT * FROM de_jackpot_sessions 
                 WHERE status = 'pending_pickup' 
                 ORDER BY created_at ASC 
                 LIMIT 1 
                 FOR UPDATE SKIP LOCKED`
            );

            if (selectRes.rows.length === 0) {
                // No more pending tasks for this helper type found in this attempt
                await client.query('COMMIT'); // or ROLLBACK, as nothing changed
                client.release(); client = null; // Release this client
                // console.log(`${logPrefixCycle} No pending jackpot sessions found to claim.`);
                break; // Exit the loop for this polling cycle
            }

            const sessionToClaim = selectRes.rows[0];
            const sessionLogPrefix = `[HelperDEJackpot_Session SID:${sessionToClaim.session_id}]`;

            // Attempt to update (claim) this specific session
            const updateRes = await client.query(
                "UPDATE de_jackpot_sessions SET status = $1, helper_bot_id = $2, updated_at = NOW() WHERE session_id = $3 AND status = 'pending_pickup' RETURNING *",
                ['active_by_helper', botUsername, sessionToClaim.session_id]
            );

            if (updateRes.rowCount > 0) {
                await client.query('COMMIT'); // Commit the successful claim
                console.log(`${sessionLogPrefix} Session claimed by ${botUsername}.`);
                claimedSessionData = updateRes.rows[0];
            } else {
                // This means another helper instance claimed it between the SELECT FOR UPDATE and this UPDATE.
                // This can happen if SKIP LOCKED wasn't fully effective or if there's a slight race.
                // Or if status wasn't 'pending_pickup' anymore.
                console.warn(`${sessionLogPrefix} Failed to claim (session ${sessionToClaim.session_id} likely picked by another instance or status changed).`);
                await client.query('ROLLBACK'); // Rollback this attempt
            }
        } catch (dbError) {
            console.error(`${logPrefixCycle} DB Error during claim attempt: ${dbError.message}`, dbError.stack?.substring(0, 300));
            if (client) {
                try { await client.query('ROLLBACK'); } 
                catch (rbErr) { console.error(`${logPrefixCycle} Claim attempt rollback error: ${rbErr.message}`); }
            }
        } finally {
            if (client) {
                client.release(); // Ensure client is always released for this attempt
            }
        }

        if (claimedSessionData) {
            // Process the claimed session (this part is outside the DB transaction for claiming)
            console.log(`${logPrefixCycle} SID:${claimedSessionData.session_id} Storing locally and sending initial prompt.`);
            activeHelperSessions.set(claimedSessionData.session_id, {
                ...claimedSessionData,
                jackpot_run_rolls: [], 
                jackpot_run_score: 0,  
                current_total_score: parseInt(claimedSessionData.initial_score, 10), 
                turnTimeoutId: null,
                initial_rolls_parsed: JSON.parse(claimedSessionData.initial_rolls_json || '[]') // Pre-parse for convenience
            });
            // This sendJackpotRunUpdate is async. We don't await it here to allow the loop 
            // to potentially pick up more sessions if MAX_SESSIONS_PER_CYCLE > 1 for this helper instance.
            // Error handling within sendJackpotRunUpdate should be robust.
            sendJackpotRunUpdate(claimedSessionData.session_id).catch(sendErr => {
                console.error(`Error in initial sendJackpotRunUpdate for SID ${claimedSessionData.session_id}: ${sendErr.message}`);
                // If the very first message fails, we should update the session status to error
                // so it doesn't get stuck in 'active_by_helper'.
                finalizeJackpotSession(claimedSessionData.session_id, 'error_helper_init_prompt', 
                                       parseInt(claimedSessionData.initial_score, 10), [], 
                                       `Failed initial prompt: ${sendErr.message.substring(0,100)}`);
            });
        } else if (selectRes && selectRes.rows.length === 0 && i === 0) {
            // If the very first attempt to select a session found nothing, no need to loop further in this polling cycle.
            break;
        }
        // Small delay if processing multiple to be slightly less aggressive on DB connections
        if (sessionsToAttemptToClaim > 1 && i < sessionsToAttemptToClaim -1) await sleep(100); 
    } // End of for loop
}

async function sendJackpotRunUpdate(sessionId, lastRollValue = null) {
    const sessionData = activeHelperSessions.get(sessionId);
    if (!sessionData) { /* ... */ return; }
    const logPrefixSession = `[HelperDEJackpot_Update SID:${sessionId}]`;

    if (sessionData.turnTimeoutId) {
        clearTimeout(sessionData.turnTimeoutId);
        sessionData.turnTimeoutId = null;
    }

    const initialRollsDisplay = formatDiceRollsHTML(sessionData.initial_rolls_parsed);
    const jackpotRunRollsDisplay = formatDiceRollsHTML(sessionData.jackpot_run_rolls);
    const jackpotPoolSol = parseFloat(BigInt(sessionData.jackpot_pool_at_session_start) / BigInt(10**9)).toFixed(2);

    // --- MODIFIED MESSAGE STRUCTURE FOR CLARITY ---
    let message = `🏆 <b>Jackpot Run!</b> (Dice by @${escapeHTML(botUsername)})\n\n` +
                  `Your score entering this run: <b>${sessionData.initial_score}</b>\n` +
                  `Rolls during this Jackpot Run: ${jackpotRunRollsDisplay}\n` +
                  `🔥 Combined Total Score: <b>${sessionData.current_total_score}</b>\n` + // Emphasize this
                  `🎯 Target for Jackpot: <b>${sessionData.target_jackpot_score}+</b> (Bust on ${sessionData.bust_on_value})\n` +
                  `💰 Jackpot Pool (this attempt): approx. <b>${escapeHTML(jackpotPoolSol)} SOL</b>\n\n`;

    if (lastRollValue !== null) {
        message += `You just rolled: 🎲<b>${lastRollValue}</b>!\n\n`;
    }

    if (sessionData.status === 'active_by_helper') {
        message += `Send 🎲 to roll again! (Timeout: ${JACKPOT_RUN_TURN_TIMEOUT_MS / 1000}s)`;
        sessionData.turnTimeoutId = setTimeout(() => {
            handleJackpotRunTurnTimeout(sessionId);
        }, JACKPOT_RUN_TURN_TIMEOUT_MS);
        console.log(`${logPrefixSession} Timeout set for next roll: ${sessionData.turnTimeoutId}`);
    } else { 
        message += `<b>${escapeHTML(sessionData.outcome_notes || "Jackpot run segment ended.")}</b>\nReporting result to Main Bot...`;
    }
    // --- END OF MODIFIED MESSAGE STRUCTURE ---

    bot.sendMessage(sessionData.chat_id, message, { parse_mode: 'HTML' }).catch(err => {
        console.error(`${logPrefixSession} Error sending jackpot run update message: ${err.message}`);
        if (err.response && (err.response.body.error_code === 403 || err.response.body.error_code === 400)) {
            finalizeJackpotSession(sessionId, 'error_sending_message', sessionData.current_total_score, sessionData.jackpot_run_rolls, `Helper failed to send message to chat: ${err.message.substring(0,100)}`);
        }
    });
    activeHelperSessions.set(sessionId, sessionData); 
}

bot.on('message', async (msg) => {
    if (isShuttingDownHelper || !msg.dice || !msg.from || msg.from.is_bot) return;

    const userId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const diceValue = msg.dice.value;

    let activeSessionId = null;
    let sessionDataRef = null;

    for (const [sId, sData] of activeHelperSessions.entries()) {
        if (String(sData.user_id) === userId && String(sData.chat_id) === chatId && sData.status === 'active_by_helper') {
            activeSessionId = sId;
            sessionDataRef = sData;
            break;
        }
    }

    if (!activeSessionId || !sessionDataRef) return;
    
    const logPrefixSession = `[HelperDEJackpot_Roll SID:${activeSessionId}]`;
    console.log(`${logPrefixSession} User ${userId} rolled ${diceValue} in jackpot run.`);
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});

    if (sessionDataRef.turnTimeoutId) {
        clearTimeout(sessionDataRef.turnTimeoutId);
        sessionDataRef.turnTimeoutId = null;
    }

    sessionDataRef.jackpot_run_rolls.push(diceValue);
    sessionDataRef.jackpot_run_score += diceValue;
    sessionDataRef.current_total_score = sessionDataRef.initial_score + sessionDataRef.jackpot_run_score;

    if (diceValue === sessionDataRef.bust_on_value) {
        console.log(`${logPrefixSession} Player BUSTED with roll ${diceValue}. Total score: ${sessionDataRef.current_total_score}`);
        await finalizeJackpotSession(activeSessionId, 'completed_bust', sessionDataRef.current_total_score, sessionDataRef.jackpot_run_rolls, `Busted on a ${diceValue} during jackpot run!`);
    } else if (sessionDataRef.current_total_score >= sessionDataRef.target_jackpot_score) {
        console.log(`${logPrefixSession} Player reached/exceeded jackpot target! Score: ${sessionDataRef.current_total_score}`);
        await finalizeJackpotSession(activeSessionId, 'completed_target_reached', sessionDataRef.current_total_score, sessionDataRef.jackpot_run_rolls, `Target ${sessionDataRef.target_jackpot_score}+ reached with score ${sessionDataRef.current_total_score}!`);
    } else {
        activeHelperSessions.set(activeSessionId, sessionDataRef); 
        await sendJackpotRunUpdate(activeSessionId, diceValue);
    }
});

async function handleJackpotRunTurnTimeout(sessionId) {
    const sessionData = activeHelperSessions.get(sessionId);
    if (!sessionData || sessionData.status !== 'active_by_helper') return;

    const logPrefixSession = `[HelperDEJackpot_Timeout SID:${sessionId}]`;
    console.log(`${logPrefixSession} User ${sessionData.user_id} timed out during jackpot run.`);
    
    await finalizeJackpotSession(sessionId, 'completed_timeout_forfeit', sessionData.current_total_score, sessionData.jackpot_run_rolls, "Turn timed out during jackpot run.");
}

async function finalizeJackpotSession(sessionId, finalStatus, finalOverallScore, jackpotRunRollsArray, outcomeNotesStr) {
    const sessionData = activeHelperSessions.get(sessionId); // Get the latest from memory
    if (!sessionData) {
        console.warn(`[HelperDEJackpot_Finalize SID:${sessionId}] No active session data found in memory to finalize.`);
        // Attempt to update DB even if memory state is lost, assuming sessionId is valid
    }
    const logPrefixSession = `[HelperDEJackpot_Finalize SID:${sessionId}]`;

    if (sessionData && sessionData.turnTimeoutId) clearTimeout(sessionData.turnTimeoutId);
    activeHelperSessions.delete(sessionId); // Remove from active management

    console.log(`${logPrefixSession} Finalizing with status: ${finalStatus}, Score: ${finalOverallScore}, Outcome: ${outcomeNotesStr}`);

    const initialRolls = JSON.parse(sessionData?.initial_rolls_json || '[]'); // Use optional chaining if sessionData might be missing
    const finalRollsCombined = JSON.stringify([...initialRolls, ...jackpotRunRollsArray]);

    let client = null;
    try {
        client = await pool.connect();
        // Only update if it was being managed by this helper, to avoid overwriting if another process took over.
        const updateResult = await client.query(
            `UPDATE de_jackpot_sessions 
             SET status = $1, final_score = $2, final_rolls_json = $3, outcome_notes = $4, updated_at = NOW() 
             WHERE session_id = $5 AND (status = 'active_by_helper' OR helper_bot_id = $6)`, // Ensure this helper was the one managing it
            [finalStatus, finalOverallScore, finalRollsCombined, outcomeNotesStr, sessionId, botUsername]
        );
        if (updateResult.rowCount > 0) {
            console.log(`${logPrefixSession} DB record updated to ${finalStatus}. Main Bot will pick this up.`);
            const finalHelperMessage = `🏆 Jackpot Run Concluded (Session ${sessionId}) 🏆\n` +
                                       `Your final total score for this attempt: <b>${finalOverallScore}</b>.\n` +
                                       `Outcome: ${escapeHTML(outcomeNotesStr)}\n\n` +
                                       `The Main Casino Bot will now process the overall game result and announce any winnings.`;
            if (sessionData) { // Only send if we had sessionData to get chat_id
                bot.sendMessage(sessionData.chat_id, finalHelperMessage, { parse_mode: 'HTML' }).catch(e => console.error(`${logPrefixSession} Error sending final helper message: ${e.message}`));
            }
        } else {
            console.warn(`${logPrefixSession} Did not update DB record for session ${sessionId}. Status might have been changed by another process or record not found for this helper.`);
        }
    } catch (dbError) {
        console.error(`${logPrefixSession} Error updating de_jackpot_sessions table to final status: ${dbError.message}`);
    } finally {
        if (client) client.release();
    }
}

// --- Telegram Bot Event Handlers ---
bot.onText(/\/start|\/help/i, async (msg) => {
    const chatId = msg.chat.id;
    let currentBotUsername = "HelperDEJackpotBot"; // Fallback
     try {
        const me = await bot.getMe();
        currentBotUsername = me.username || currentBotUsername;
    } catch(e) {/* ignore */}
    const helpText = `I am @${currentBotUsername}, a dedicated helper bot for Dice Escalator Jackpot Runs for the main casino bot.\n` +
                     `I take over once you enter jackpot mode and manage your rolls for the big prize!\n` +
                     `You typically don't need to interact with me directly via commands.`;
    bot.sendMessage(chatId, helpText);
});

bot.on('polling_error', (error) => console.error(`\n🚫 HelperDEJackpot TELEGRAM POLLING ERROR 🚫 Code: ${error.code}, Msg: ${error.message}`));
bot.on('error', (error) => console.error('\n🔥 HelperDEJackpot GENERAL TELEGRAM LIBRARY ERROR EVENT 🔥:', error));

// --- Startup Function ---
let dbPollingIntervalId = null;
let isShuttingDownHelper = false;

async function startHelperBot() {
    console.log(`\n🚀🚀🚀 Initializing HelperDEJackpot Bot 🚀🚀🚀`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    try {
        const dbClient = await pool.connect();
        console.log("HelperDEJackpot: ✅ DB connected for startup test.");
        await dbClient.query('SELECT NOW()');
        dbClient.release();
        
        // bot.getMe() for username is now at the top

        dbPollingIntervalId = setInterval(() => {
            if (!isShuttingDownHelper) {
                checkAndInitiateJackpotSessions().catch(err => {
                    console.error(`[HelperDEJackpot] Uncaught error in checkAndInitiateJackpotSessions interval:`, err);
                });
            }
        }, POLLING_INTERVAL_MS);
        console.log(`HelperDEJackpot: ✅ DB polling for jackpot sessions started (Interval: ${POLLING_INTERVAL_MS}ms).`);
        console.log(`\n🎉 HelperDEJackpot Bot operational!`);
    } catch (error) {
        console.error("❌ CRITICAL STARTUP ERROR (HelperDEJackpot Bot):", error);
        if (pool) { try { await pool.end(); } catch (e) { /* ignore */ } }
        process.exit(1);
    }
}

// --- Shutdown Handling ---
async function shutdownHelper(signal) {
    if (isShuttingDownHelper) {
        console.log("HelperDEJackpot: Shutdown already in progress."); return;
    }
    isShuttingDownHelper = true;
    console.log(`\n🚦 Received ${signal}. Shutting down HelperDEJackpot Bot...`);
    if (dbPollingIntervalId) clearInterval(dbPollingIntervalId);
    console.log("HelperDEJackpot: DB polling stopped.");

    activeHelperSessions.forEach(sessionData => {
        if (sessionData.turnTimeoutId) clearTimeout(sessionData.turnTimeoutId);
    });
    console.log("HelperDEJackpot: Cleared active session timeouts.");

    if (bot && typeof bot.stopPolling === 'function' && bot.isPolling()) {
        try { await bot.stopPolling({ cancel: true }); console.log("HelperDEJackpot: Telegram polling stopped."); }
        catch(e) { console.error("HelperDEJackpot: Error stopping Telegram polling:", e.message); }
    } else if (bot && typeof bot.close === 'function') { // For non-polling bots or as a general close
        try { await bot.close(); console.log("HelperDEJackpot: Telegram bot connection closed."); }
        catch(e) { console.error("HelperDEJackpot: Error closing Telegram bot connection:", e.message); }
    }
    if (pool) {
        try { await pool.end(); console.log("HelperDEJackpot: PostgreSQL pool closed."); }
        catch(e) { console.error("HelperDEJackpot: Error closing PostgreSQL pool:", e.message); }
    }
    console.log("HelperDEJackpot: ✅ Shutdown complete. Exiting.");
    process.exit(0);
}

process.on('SIGINT', async () => await shutdownHelper('SIGINT'));
process.on('SIGTERM', async () => await shutdownHelper('SIGTERM'));
process.on('uncaughtException', (error, origin) => {
    console.error(`\n🚨🚨 HelperDEJackpot UNCAUGHT EXCEPTION AT: ${origin} 🚨🚨`, error);
    if (!isShuttingDownHelper) {
      shutdownHelper('uncaughtException_exit').catch(() => process.exit(1));
    } else { process.exit(1); }
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`\n🔥🔥 HelperDEJackpot UNHANDLED REJECTION 🔥🔥 At Promise:`, promise, `Reason:`, reason);
});

// --- Start the Bot ---
startHelperBot();

console.log("HelperDEJackpot Bot: End of script. Startup process initiated.");
