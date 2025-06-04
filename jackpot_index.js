// jackpot_index.js - Dedicated Helper Bot for Dice Escalator Jackpot Runs

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';
import axios from 'axios'; // Needed for price fetching

// --- Environment Variable Validation & Configuration ---
console.log("HelperDEJackpot: Loading environment variables...");

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

// --- Constants and Price Utilities for Helper Bot ---
const LAMPORTS_PER_SOL = 1000000000;
const SOL_PRICE_API_URL_HELPER = process.env.SOL_PRICE_API_URL_HELPER || process.env.SOL_PRICE_API_URL || 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const MAIN_BOT_USERNAME_FOR_HELPER = process.env.MAIN_BOT_USERNAME || "MainCasinoBot";

if (!SOL_PRICE_API_URL_HELPER && !process.env.SOL_PRICE_API_URL) { // Check if either is defined
    console.warn("HelperDEJackpot: Neither SOL_PRICE_API_URL_HELPER nor SOL_PRICE_API_URL are defined. USD conversions for jackpot pool will fail or show N/A.");
}

// Simple cache for the helper bot's SOL/USD price
const helperSolPriceCache = { price: null, timestamp: 0, isFetching: false };
const HELPER_SOL_USD_PRICE_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

async function fetchSolUsdPriceFromAPIForHelper() {
    const apiUrl = SOL_PRICE_API_URL_HELPER;
    const logPrefix = '[HelperDEJackpot_PriceFeed]';
    if (!apiUrl) {
        console.error(`${logPrefix} API URL is not configured.`);
        throw new Error('Price API URL not configured for helper.');
    }
    // console.log(`${logPrefix} Fetching SOL/USD price from ${apiUrl}...`); // Can be verbose
    try {
        const response = await axios.get(apiUrl, { timeout: 6000 });
        if (response.data && response.data.solana && typeof response.data.solana.usd === 'number') {
            const price = parseFloat(response.data.solana.usd);
            if (isNaN(price) || price <= 0) {
                throw new Error('Invalid or non-positive price data from API.');
            }
            // console.log(`${logPrefix} Fetched price: $${price}`); // Can be verbose
            return price;
        } else {
            console.error(`${logPrefix} ⚠️ SOL price not found or invalid structure in API response:`, response.data);
            throw new Error('SOL price not found or invalid structure in API response for helper.');
        }
    } catch (error) {
        const errMsg = error.isAxiosError ? error.message : String(error);
        console.error(`${logPrefix} ❌ Error fetching SOL/USD price: ${errMsg}`);
        if (error.response) {
            console.error(`${logPrefix} API Response Status: ${error.response.status}`);
        }
        throw new Error(`Failed to fetch SOL/USD price for helper: ${errMsg}`);
    }
}

async function getSolUsdPriceForHelper() {
    const logPrefix = '[HelperDEJackpot_GetPrice]';
    const now = Date.now();
    if (helperSolPriceCache.price !== null && (now - helperSolPriceCache.timestamp < HELPER_SOL_USD_PRICE_CACHE_TTL_MS)) {
        return helperSolPriceCache.price;
    }
    if (helperSolPriceCache.isFetching) {
        // console.log(`${logPrefix} Price fetch already in progress. Returning stale if available.`); // Can be verbose
        // Return stale if available while another fetch is ongoing
        if (helperSolPriceCache.price !== null) return helperSolPriceCache.price;
        // Or wait a very short time for the ongoing fetch to possibly complete
        await new Promise(resolve => setTimeout(resolve, 750));
        if (helperSolPriceCache.price !== null && (Date.now() - helperSolPriceCache.timestamp < HELPER_SOL_USD_PRICE_CACHE_TTL_MS)) {
             return helperSolPriceCache.price;
        }
    }
    helperSolPriceCache.isFetching = true;
    try {
        const price = await fetchSolUsdPriceFromAPIForHelper();
        helperSolPriceCache.price = price;
        helperSolPriceCache.timestamp = now;
        return price;
    } catch (error) {
        console.error(`${logPrefix} Failed to get fresh SOL/USD price. Details: ${error.message}`);
        if (helperSolPriceCache.price !== null) {
            console.warn(`${logPrefix} Using stale price due to error: $${helperSolPriceCache.price}`);
            return helperSolPriceCache.price;
        }
        // If no stale price, this will propagate error
        throw new Error(`Unable to retrieve SOL/USD price for helper: ${error.message}`);
    } finally {
        helperSolPriceCache.isFetching = false;
    }
}

function convertLamportsToUSDStringForHelper(lamports, solUsdPrice, displayDecimals = 2) {
    if (typeof solUsdPrice !== 'number' || solUsdPrice <= 0) {
        return 'Price N/A';
    }
    let lamportsAsBigInt;
    try {
        lamportsAsBigInt = BigInt(lamports);
    } catch (e) {
        return 'Amount Error';
    }
    const solAmount = Number(lamportsAsBigInt) / Number(LAMPORTS_PER_SOL);
    const usdValue = solAmount * solUsdPrice;
    return `$${usdValue.toLocaleString('en-US', { minimumFractionDigits: displayDecimals, maximumFractionDigits: displayDecimals })}`;
}
// --- End of Constants and Price Utilities ---


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
}).catch(err => console.error(`HelperDEJackpot: Failed to get bot info: ${err.message}. Using default username: @${botUsername}.`));

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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


// --- Database Polling to Pick Up New Jackpot Sessions ---
async function checkAndInitiateJackpotSessions() {
    if (isShuttingDownHelper) return;

    const activeSessionCount = activeHelperSessions.size;
    const maxConcurrentSessionsThisHelper = MAX_SESSIONS_PER_CYCLE;

    if (activeSessionCount >= maxConcurrentSessionsThisHelper) {
        return;
    }

    const sessionsToAttemptToClaim = maxConcurrentSessionsThisHelper - activeSessionCount;
    if (sessionsToAttemptToClaim <= 0) {
        return;
    }

    for (let i = 0; i < sessionsToAttemptToClaim; i++) {
        if (isShuttingDownHelper) {
            console.log("[HelperDEJackpot_Poll] Shutdown detected during claim loop.");
            break;
        }

        let client = null;
        let claimedSessionData = null;
        const logPrefixCycle = `[HelperDEJackpot_PollAttempt ${i+1}/${sessionsToAttemptToClaim}]`;

        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const selectRes = await client.query(
                `SELECT * FROM de_jackpot_sessions 
                 WHERE status = 'pending_pickup' 
                 ORDER BY created_at ASC 
                 LIMIT 1 
                 FOR UPDATE SKIP LOCKED`
            );

            if (selectRes.rows.length === 0) {
                await client.query('COMMIT');
                client.release(); client = null;
                break;
            }

            const sessionToClaim = selectRes.rows[0];
            const sessionLogPrefixInfo = `[HelperDEJackpot_SessionInfo SID:${sessionToClaim.session_id}]`; // For info logging before claim

            // Attempt to update (claim) this specific session
            const updateRes = await client.query(
                "UPDATE de_jackpot_sessions SET status = $1, helper_bot_id = $2, updated_at = NOW() WHERE session_id = $3 AND status = 'pending_pickup' RETURNING *",
                ['active_by_helper', botUsername, sessionToClaim.session_id]
            );

            if (updateRes.rowCount > 0) {
                await client.query('COMMIT');
                console.log(`${sessionLogPrefixInfo} Session successfully claimed by ${botUsername}.`);
                claimedSessionData = updateRes.rows[0];
            } else {
                console.warn(`${sessionLogPrefixInfo} Failed to claim (session ${sessionToClaim.session_id} likely picked by another instance or status changed before update).`);
                await client.query('ROLLBACK');
            }
        } catch (dbError) {
            console.error(`${logPrefixCycle} DB Error during claim attempt: ${dbError.message}`, dbError.stack?.substring(0, 300));
            if (client) {
                try { await client.query('ROLLBACK'); }
                catch (rbErr) { console.error(`${logPrefixCycle} Claim attempt rollback error: ${rbErr.message}`); }
            }
        } finally {
            if (client) {
                client.release();
            }
        }

        if (claimedSessionData) {
            console.log(`${logPrefixCycle} SID:${claimedSessionData.session_id} Storing locally and sending initial prompt.`);
            activeHelperSessions.set(claimedSessionData.session_id, {
                ...claimedSessionData,
                jackpot_run_rolls: [],
                jackpot_run_score: 0,
                current_total_score: parseInt(claimedSessionData.initial_score, 10),
                turnTimeoutId: null,
                initial_rolls_parsed: JSON.parse(claimedSessionData.initial_rolls_json || '[]')
            });
            sendJackpotRunUpdate(claimedSessionData.session_id).catch(sendErr => {
                console.error(`Error in initial sendJackpotRunUpdate for SID ${claimedSessionData.session_id}: ${sendErr.message}`);
                finalizeJackpotSession(claimedSessionData.session_id, 'error_helper_init_prompt',
                                       parseInt(claimedSessionData.initial_score, 10), [],
                                       `Failed initial prompt: ${String(sendErr.message).substring(0,100)}`);
            });
        } else if (selectRes && selectRes.rows.length === 0 && i === 0) {
            break;
        }
        if (sessionsToAttemptToClaim > 1 && i < sessionsToAttemptToClaim -1) await sleep(250); // Slightly longer delay
    }
}

async function sendJackpotRunUpdate(sessionId, lastRollValue = null) {
    const sessionData = activeHelperSessions.get(sessionId);
    if (!sessionData) {
        console.warn(`[HelperDEJackpot_Update SID:${sessionId}] No active session data found.`);
        return;
    }
    const logPrefixSession = `[HelperDEJackpot_Update SID:${sessionId}]`;

    if (sessionData.turnTimeoutId) {
        clearTimeout(sessionData.turnTimeoutId);
        sessionData.turnTimeoutId = null;
    }

    const initialRollsDisplay = formatDiceRollsHTML(sessionData.initial_rolls_parsed);
    const jackpotRunRollsDisplay = formatDiceRollsHTML(sessionData.jackpot_run_rolls);

    let jackpotPoolDisplayHTML = "Calculating...";
    try {
        const solPrice = await getSolUsdPriceForHelper();
        jackpotPoolDisplayHTML = escapeHTML(convertLamportsToUSDStringForHelper(sessionData.jackpot_pool_at_session_start, solPrice));
    } catch (priceError) {
        console.warn(`${logPrefixSession} Could not get SOL/USD price for jackpot pool display: ${priceError.message}`);
        const jackpotPoolSol = parseFloat(BigInt(sessionData.jackpot_pool_at_session_start) / BigInt(LAMPORTS_PER_SOL)).toFixed(2);
        jackpotPoolDisplayHTML = `~${escapeHTML(jackpotPoolSol)} SOL (USD price error)`;
    }

    let message = `🏆 <b>Jackpot Run!</b> (Dice by @${escapeHTML(botUsername)})\n\n` +
                  `Your score entering this run: <b>${sessionData.initial_score}</b>\n` +
                  `Rolls during this Jackpot Run: ${jackpotRunRollsDisplay}\n` +
                  `🔥 Combined Total Score: <b>${sessionData.current_total_score}</b>\n` +
                  `🎯 Target for Jackpot: <b>${sessionData.target_jackpot_score}+</b> (Bust on ${sessionData.bust_on_value})\n` +
                  `💰 Jackpot Pool: <b>${jackpotPoolDisplayHTML}</b>\n\n`;

    if (lastRollValue !== null) {
        message += `You just rolled: 🎲<b>${lastRollValue}</b>!\n\n`;
    }

    if (sessionData.status === 'active_by_helper') {
        message += `Send 🎲 to roll again! (Timeout: ${JACKPOT_RUN_TURN_TIMEOUT_MS / 1000}s)`;
        sessionData.turnTimeoutId = setTimeout(() => {
            handleJackpotRunTurnTimeout(sessionId);
        }, JACKPOT_RUN_TURN_TIMEOUT_MS);
    } else {
        message += `<b>${escapeHTML(sessionData.outcome_notes || "Jackpot run segment ended.")}</b>\nReporting result to Main Bot...`;
    }

    bot.sendMessage(sessionData.chat_id, message, { parse_mode: 'HTML' }).catch(err => {
        console.error(`${logPrefixSession} Error sending jackpot run update message: ${err.message}`);
        if (err.response && (err.response.body.error_code === 403 || err.response.body.error_code === 400)) {
            finalizeJackpotSession(sessionId, 'error_sending_message', sessionData.current_total_score, sessionData.jackpot_run_rolls, `Helper failed to send update to chat: ${err.message.substring(0,100)}`);
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
    sessionDataRef.current_total_score = parseInt(sessionDataRef.initial_score, 10) + sessionDataRef.jackpot_run_score; // Ensure initial_score is number

    if (diceValue === parseInt(sessionDataRef.bust_on_value, 10)) { // Ensure bust_on_value is number
        console.log(`${logPrefixSession} Player BUSTED with roll ${diceValue}. Total score: ${sessionDataRef.current_total_score}`);
        await finalizeJackpotSession(activeSessionId, 'completed_bust', sessionDataRef.current_total_score, sessionDataRef.jackpot_run_rolls, `Busted on a ${diceValue} during jackpot run!`);
    } else if (sessionDataRef.current_total_score >= parseInt(sessionDataRef.target_jackpot_score, 10)) { // Ensure target_jackpot_score is number
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
    const sessionData = activeHelperSessions.get(sessionId);
    const logPrefixSession = `[HelperDEJackpot_Finalize SID:${sessionId}]`;

    if (sessionData && sessionData.turnTimeoutId) clearTimeout(sessionData.turnTimeoutId);
    activeHelperSessions.delete(sessionId);

    console.log(`${logPrefixSession} Finalizing with status: ${finalStatus}, Score: ${finalOverallScore}, Outcome: ${outcomeNotesStr}`);

    const initialRolls = JSON.parse(sessionData?.initial_rolls_json || '[]');
    const finalRollsCombined = JSON.stringify([...initialRolls, ...jackpotRunRollsArray]);

    let finalHelperMessageTitle = "";
    let finalHelperMessageBody = "";
    const escapedOutcomeNotes = escapeHTML(outcomeNotesStr);
    const scoreDisplay = `Your final score for this jackpot attempt: <b>${finalOverallScore}</b>.`;

    switch(finalStatus) {
        case 'completed_bust':
            finalHelperMessageTitle = `💥 Oops! Jackpot Run Halted (Session ${sessionId}) 💥`;
            finalHelperMessageBody = `${scoreDisplay}\n${escapedOutcomeNotes} Tough break! Maybe next time the dice will be kinder.`;
            break;
        case 'completed_target_reached':
            finalHelperMessageTitle = `🎉🎯 Jackpot Target Smashed! (Session ${sessionId}) 🎯🎉`;
            finalHelperMessageBody = `${scoreDisplay}\n${escapedOutcomeNotes} Absolutely legendary rolling! You've done it!`;
            break;
        case 'completed_timeout_forfeit':
            finalHelperMessageTitle = `⏳ Time's Up! (Session ${sessionId}) ⏳`;
            finalHelperMessageBody = `${scoreDisplay}\n${escapedOutcomeNotes} The clock ran out on this jackpot attempt.`;
            break;
        case 'error_sending_message':
        case 'error_helper_init_prompt':
        default:
            finalHelperMessageTitle = `⚠️ Jackpot Run Update (Session ${sessionId}) ⚠️`;
            finalHelperMessageBody = `There was an issue with your jackpot run.\nDetails: ${escapedOutcomeNotes}`;
            break;
    }

    const finalHelperMessage = `${finalHelperMessageTitle}\n\n${finalHelperMessageBody}\n\nThe Main Casino Bot (@${escapeHTML(MAIN_BOT_USERNAME_FOR_HELPER)}) will now process the final game result. Stand by!`;

    let client = null;
    try {
        client = await pool.connect();
        const updateResult = await client.query(
            `UPDATE de_jackpot_sessions 
             SET status = $1, final_score = $2, final_rolls_json = $3, outcome_notes = $4, updated_at = NOW() 
             WHERE session_id = $5 AND (status = 'active_by_helper' OR helper_bot_id = $6)`,
            [finalStatus, finalOverallScore, finalRollsCombined, outcomeNotesStr, sessionId, botUsername]
        );
        if (updateResult.rowCount > 0) {
            console.log(`${logPrefixSession} DB record updated to ${finalStatus}. Main Bot will pick this up.`);
            if (sessionData && sessionData.chat_id) {
                bot.sendMessage(sessionData.chat_id, finalHelperMessage, { parse_mode: 'HTML' }).catch(e => console.error(`${logPrefixSession} Error sending final helper message: ${e.message}`));
            } else {
                console.warn(`${logPrefixSession} Could not send final helper message because sessionData or chat_id was missing for session ${sessionId}.`);
            }
        } else {
            console.warn(`${logPrefixSession} Did not update DB record for session ${sessionId}. Status might have been changed by another process or record not found for this helper. Current DB status might persist if not 'active_by_helper' or helper_bot_id mismatch.`);
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
    let currentBotUsername = botUsername; // Use already fetched/defaulted username
    const helpText = `I am @${currentBotUsername}, a dedicated helper bot for Dice Escalator Jackpot Runs for the main casino bot (@${escapeHTML(MAIN_BOT_USERNAME_FOR_HELPER)}).\n` +
                     `I take over once you enter jackpot mode and manage your rolls for the big prize!\n` +
                     `You typically don't need to interact with me directly via commands.`;
    bot.sendMessage(chatId, helpText);
});

bot.on('polling_error', (error) => console.error(`\n🚫 HelperDEJackpot TELEGRAM POLLING ERROR 🚫 Code: ${error.code || 'N/A'}, Msg: ${error.message}`));
bot.on('error', (error) => console.error('\n🔥 HelperDEJackpot GENERAL TELEGRAM LIBRARY ERROR EVENT 🔥:', error));

// --- Startup Function ---
let dbPollingIntervalId = null;
let isShuttingDownHelper = false;

async function startHelperBot() {
    console.log(`\n🚀🚀🚀 Initializing HelperDEJackpot Bot (v2 Price Logic) 🚀🚀🚀`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    try {
        const dbClient = await pool.connect();
        console.log("HelperDEJackpot: ✅ DB connected for startup test.");
        await dbClient.query('SELECT NOW()');
        dbClient.release();

        // Attempt to fetch SOL price once at startup to populate cache or identify issues early
        try {
            const initialPrice = await getSolUsdPriceForHelper();
            console.log(`HelperDEJackpot: ✅ Initial SOL/USD Price fetched: $${initialPrice.toFixed(2)}`);
        } catch(priceErr) {
            console.warn(`HelperDEJackpot: ⚠️ Could not fetch initial SOL/USD price at startup: ${priceErr.message}. USD conversions might be delayed or show N/A initially.`);
        }

        dbPollingIntervalId = setInterval(() => {
            if (!isShuttingDownHelper) {
                checkAndInitiateJackpotSessions().catch(err => {
                    console.error(`[HelperDEJackpot] Uncaught error in checkAndInitiateJackpotSessions interval:`, err);
                });
            }
        }, POLLING_INTERVAL_MS);
        console.log(`HelperDEJackpot: ✅ DB polling for jackpot sessions started (Interval: ${POLLING_INTERVAL_MS}ms).`);
        console.log(`\n🎉 HelperDEJackpot Bot operational! Listening for jackpot sessions...`);
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

    if (bot && typeof bot.stopPolling === 'function') { // Check if stopPolling exists (it does for polling:true)
        try {
            if (bot.isPolling()) { // Check if actually polling
                 await bot.stopPolling({ cancel: true }); console.log("HelperDEJackpot: Telegram polling stopped.");
            } else {
                 console.log("HelperDEJackpot: Telegram bot was not polling.");
            }
        }
        catch(e) { console.error("HelperDEJackpot: Error stopping Telegram polling:", e.message); }
    } else if (bot && typeof bot.close === 'function') {
        try { await bot.close(); console.log("HelperDEJackpot: Telegram bot connection closed (via close method)."); }
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
      shutdownHelper('uncaughtException_exit').catch(() => process.exit(1)); // Attempt graceful, then force
      setTimeout(() => process.exit(1), 5000); // Force exit after timeout
    } else { process.exit(1); } // Already shutting down, force exit
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`\n🔥🔥 HelperDEJackpot UNHANDLED REJECTION 🔥🔥 At Promise:`, promise, `Reason:`, reason);
    // Optionally, you might want to treat critical unhandled rejections as reasons to shut down
    // if (!isShuttingDownHelper) {
    //  console.log("HelperDEJackpot: Initiating shutdown due to unhandled promise rejection.");
    //  shutdownHelper('unhandledRejection_exit').catch(() => process.exit(1));
    //  setTimeout(() => process.exit(1), 5000);
    // }
});

// --- Start the Bot ---
startHelperBot();

console.log("HelperDEJackpot Bot: End of script. Startup process initiated.");
