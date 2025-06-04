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
    let client = null;
    try {
        client = await pool.connect();
        
        const activeSessionCount = activeHelperSessions.size;
        if (activeSessionCount >= MAX_SESSIONS_PER_CYCLE) {
            // console.log(`[HelperDEJackpot_Poll] Already managing ${activeSessionCount} session(s). Max per cycle: ${MAX_SESSIONS_PER_CYCLE}. Skipping new claims this cycle.`);
            client.release();
            return;
        }
        
        await client.query('BEGIN');

        const selectQuery = `
            SELECT * FROM de_jackpot_sessions 
            WHERE status = 'pending_pickup' 
            ORDER BY created_at ASC 
            LIMIT $1 
            FOR UPDATE SKIP LOCKED`;
        // Limit how many new sessions we pick up based on how many we are already managing
        const limitForQuery = MAX_SESSIONS_PER_CYCLE - activeSessionCount;
        if (limitForQuery <= 0) {
            await client.query('COMMIT'); // Or ROLLBACK, though nothing changed
            client.release();
            return;
        }

        const result = await client.query(selectQuery, [limitForQuery]);

        if (result.rows.length === 0) {
            await client.query('COMMIT');
            client.release();
            return;
        }

        console.log(`[HelperDEJackpot_Poll] Found ${result.rows.length} pending jackpot session(s) to claim.`);

        for (const session of result.rows) {
            if (isShuttingDownHelper) {
                console.log(`[HelperDEJackpot_Session SID:${session.session_id}] Shutdown initiated, skipping claim.`);
                break; 
            }
            const logPrefixSession = `[HelperDEJackpot_Session SID:${session.session_id} GID:${session.main_bot_game_id}]`;
            console.log(`${logPrefixSession} Attempting to claim session for UserID: ${session.user_id}`);

            try {
                const updateRes = await client.query(
                    "UPDATE de_jackpot_sessions SET status = $1, helper_bot_id = $2, updated_at = NOW() WHERE session_id = $3 AND status = 'pending_pickup' RETURNING *",
                    ['active_by_helper', botUsername, session.session_id]
                );

                if (updateRes.rowCount > 0) {
                    const activeSessionData = updateRes.rows[0];
                    // Commit this specific claim before proceeding with long-running game logic for this session
                    // This specific COMMIT is for the UPDATE above. The outer BEGIN/COMMIT handles the SELECT FOR UPDATE.
                    // Simpler: Let outer BEGIN/COMMIT handle it. If processActiveSession errors, outer rollback occurs.
                    // await client.query('COMMIT'); 

                    console.log(`${logPrefixSession} Session claimed and set to 'active_by_helper'. Storing locally.`);
                    activeHelperSessions.set(activeSessionData.session_id, {
                        ...activeSessionData, // All fields from DB
                        jackpot_run_rolls: [], 
                        jackpot_run_score: 0,  
                        current_total_score: parseInt(activeSessionData.initial_score, 10), 
                        turnTimeoutId: null,
                        initial_rolls_parsed: JSON.parse(activeSessionData.initial_rolls_json || '[]') // Pre-parse for convenience
                    });
                    
                    await sendJackpotRunUpdate(activeSessionData.session_id); // Send initial prompt & set timeout
                } else {
                    console.warn(`${logPrefixSession} Could not claim session (already picked up or status changed).`);
                    // No need to rollback here if claim failed, means another helper got it or state changed.
                }
            } catch (claimError) {
                console.error(`${logPrefixSession} Error claiming or initiating session: ${claimError.message}`);
                // Don't rollback here as it might affect other claims in a batched loop.
                // The FOR UPDATE SKIP LOCKED should handle concurrency.
                // If a specific claim attempt fails, we log and move on. The outer transaction will eventually commit or rollback.
            }
        }
        await client.query('COMMIT'); // Commit all successful claims or changes from the loop
    } catch (error) {
        console.error('[HelperDEJackpot_Poll] Error during DB check/processing cycle:', error);
        if (client) {
            try { await client.query('ROLLBACK'); }
            catch (rollbackError) { console.error('[HelperDEJackpot_Poll] Failed to rollback:', rollbackError); }
        }
    } finally {
        if (client) client.release();
    }
}

async function sendJackpotRunUpdate(sessionId, lastRollValue = null) {
    const sessionData = activeHelperSessions.get(sessionId);
    if (!sessionData) {
        console.warn(`[HelperDEJackpot_Update SID:${sessionId}] No active session found to update message.`);
        return;
    }
    const logPrefixSession = `[HelperDEJackpot_Update SID:${sessionId}]`;

    if (sessionData.turnTimeoutId) {
        clearTimeout(sessionData.turnTimeoutId);
        sessionData.turnTimeoutId = null;
    }

    const initialRollsDisplay = formatDiceRollsHTML(sessionData.initial_rolls_parsed);
    const jackpotRunRollsDisplay = formatDiceRollsHTML(sessionData.jackpot_run_rolls);
    const jackpotPoolSol = parseFloat(BigInt(sessionData.jackpot_pool_at_session_start) / BigInt(10**9)).toFixed(2);


    let message = `🏆 <b>Jackpot Run!</b> (Dice by @${escapeHTML(botUsername)})\n\n` +
                  `Your score (before this run): <b>${sessionData.initial_score}</b> (Rolls: ${initialRollsDisplay})\n` +
                  `Jackpot Run Rolls: ${jackpotRunRollsDisplay}\n` +
                  `Jackpot Run Score: <b>${sessionData.jackpot_run_score}</b>\n` +
                  `🔥 Current Total Score: <b>${sessionData.current_total_score}</b>\n` +
                  `🎯 Target: <b>${sessionData.target_jackpot_score}+</b> (Bust on ${sessionData.bust_on_value})\n` +
                  `💰 Jackpot (this attempt): approx. <b>${escapeHTML(jackpotPoolSol)} SOL</b>\n\n`;

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

    bot.sendMessage(sessionData.chat_id, message, { parse_mode: 'HTML' }).catch(err => {
        console.error(`${logPrefixSession} Error sending jackpot run update message: ${err.message}`);
        if (err.response && (err.response.body.error_code === 403 || err.response.body.error_code === 400)) { // Bot blocked or bad request
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
