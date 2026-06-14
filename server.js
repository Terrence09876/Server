require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const winston = require("winston");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

// ============================================================
//  CONSTANTS & CONFIG
// ============================================================
const CONFIG = {
  MAX_HISTORY_LENGTH: 15,
  CACHE_TTL_MS: 60_000,
  FETCH_TIMEOUT_MS: 6_000,
  PORT: process.env.PORT || 3000,
  RACE_TIMEOUT_MS: 2500,
};

// ============================================================
//  NEW SYSTEM PROMPT
// ============================================================
const systemPrompt = `Context: You're an experienced developer hanging out in the terminal. No corporate jargon, no robotic responses — just genuine conversations backed by deep technical knowledge. 

Style Guide:
- Keep things relaxed and natural.
- Use casual language where it fits, but stay clear and professional.
- Never say things like "As an AI..." or "I am programmed to...". Just speak normally.
- Keep answers concise and easy to follow. Go deeper only when they want more detail.
- Avoid overly rigid formatting, excessive headers, or numbered lists unless they genuinely improve readability.
- Explain complex topics in a way that feels like you're helping a friend, not reading documentation.
- Match the user's energy and adapt to the conversation naturally.
- Be knowledgeable, honest, and practical. Never exaggerate or make things up.

Identity: If someone asks about you, you're here to help keep the TEERA ecosystem healthy, educate users, and help people avoid scams and rugs. You're passionate about building useful tools and creating a safer web3 space.

Tone: Talk to people like a trusted friend who knows their stuff. Conversations should feel effortless, approachable, and human — like chatting with someone who's been around the space for years.`;

// ============================================================
//  SYSTEM LOGGING & PERSISTENT MEMORY STORAGE
// ============================================================
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

const MEMORY_FOLDER = path.join(__dirname, "memory");
if (!fs.existsSync(MEMORY_FOLDER)) {
  fs.mkdirSync(MEMORY_FOLDER);
}

const lastAnalysis = new Map();
const apiCache = new Map();

function getMemoryPath(sessionId) {
  return path.join(MEMORY_FOLDER, `${sessionId}.json`);
}

function getConversation(sessionId = "default") {
  const filePath = getMemoryPath(sessionId);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify([]));
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
}

function saveConversation(sessionId, history) {
  fs.writeFileSync(getMemoryPath(sessionId), JSON.stringify(history, null, 2));
}

function updateConversation(sessionId, role, content) {
  const history = getConversation(sessionId);
  history.push({ role, content, timestamp: Date.now() });
  if (history.length > CONFIG.MAX_HISTORY_LENGTH) {
    history.shift();
  }
  saveConversation(sessionId, history);
}

// ============================================================
//  CACHE OPERATIONS
// ============================================================
function getCached(key) {
  const cached = apiCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CONFIG.CACHE_TTL_MS) {
    apiCache.delete(key);
    return null;
  }
  return cached.data;
}

function setCache(key, data) {
  apiCache.set(key, { data, timestamp: Date.now() });
}

// ============================================================
//  SECURITY WARDEN MIDDLEWARE
// ============================================================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 45,
  message: { reply: "Too many telemetry cycles. Throttled." }
});
app.use("/chat", limiter);

// ============================================================
//  REGULAR EXPRESSION NETWORK HELPERS
// ============================================================
function getChainType(address) {
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return "evm";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return "solana";
  return "unknown";
}

async function resolveTokenToAddress(query) {
  if (getChainType(query) !== "unknown") {
    return { address: query, chain: getChainType(query) };
  }
  return null;
}

function extractTokenFromMessage(message) {
  if (!message) return null;
  const match = message.match(/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/);
  return match ? match[0] : null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ============================================================
//  DATA CHANNEL API READERS
// ============================================================
async function callDexScreener(token) {
  const key = `dex-${token}`;
  const cached = getCached(key);
  if (cached) return cached;
  try {
    const res = await fetchWithTimeout(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (!res.ok) return null;
    const data = await res.json();
    setCache(key, data);
    return data;
  } catch (error) {
    logger.error(`DexScreener API call failed for token ${token}: ${error.message}`);
    return null;
  }
}

async function callGoPlus(chainId, token) {
  const tokenKey = token.toLowerCase();
  const key = `goplus-${chainId}-${tokenKey}`;
  const cached = getCached(key);
  if (cached) return cached;
  
  const headers = process.env.GOPLUS_API_KEY ? { Authorization: `Bearer ${process.env.GOPLUS_API_KEY}` } : {};
  try {
    const res = await fetchWithTimeout(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenKey}`,
      { headers }
    );
    if (!res.ok) {
      const errorText = await res.text();
      logger.error(`GoPlus API call failed for token ${token} on chain ${chainId}: ${res.status} - ${errorText}`);
      return null;
    }
    const data = await res.json();
    setCache(key, data);
    return data;
  } catch (error) {
    logger.error(`GoPlus API call failed for token ${token} on chain ${chainId}: ${error.message}`);
    return null;
  }
}

async function callRugCheck(token) {
  const key = `rug-${token}`;
  const cached = getCached(key);
  if (cached) return cached;

  const headers = process.env.RUGCHECK_API_KEY ? { Authorization: `Bearer ${process.env.RUGCHECK_API_KEY}` } : {};
  try {
    const res = await fetchWithTimeout(`https://api.rugcheck.xyz/v1/tokens/${token}/report`, { headers });
    if (!res.ok) {
  const errorText = await res.text();

  console.log("RUGCHECK ERROR:");
  console.log(res.status);
  console.log(errorText);

  logger.error(
    `RugCheck API call failed for token ${token}: ${res.status} - ${errorText}`
  );

  return null;
}
    const data = await res.json();
    setCache(key, data);
    return data;
  } catch (error) {
    logger.error(`RugCheck API call failed for token ${token}: ${error.message}`);
    return null;
  }
}

// ============================================================
//  LIVE CONVERSATIONAL MULTI-MODEL RACE ENGINES
// ============================================================
async function callGemini(history) {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: history.map(m => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }]
          }))
        })
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch { return null; }
}

async function callGroq(history) {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: history.map(m => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content
        }))
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

async function raceToSuccess(promises) {
  return new Promise(resolve => {
    let done = false;
    let resolvedCount = 0;
    
    if (!promises.length) return resolve(null);

    promises.forEach(p => {
      p.then(res => {
        if (!done && res) {
          done = true;
          resolve(res);
        }
      }).catch(() => {})
      .finally(() => {
        resolvedCount++;
        if (resolvedCount === promises.length && !done) {
          resolve(null);
        }
      });
    });

    setTimeout(() => { if (!done) { done = true; resolve(null); } }, CONFIG.RACE_TIMEOUT_MS);
  });
}

// ============================================================
//  DETERMINISTIC HEURISTICS EVALUATOR + REPORT FUNCTIONS
// ============================================================
function calculateRisk({
  liquidity,
  volume,
  warnings = [],
  criticalWarnings = 0,
  isMintable = false,
  isHoneypot = false,
  isProxy = false,
  ownershipRenounced = true,
  holderConcentration = 0,
  devHolding = 0,
  hasTradingTax = false,
  isRenounced = false,
  isLocked = false,
  creatorBalance = 0,
  creatorPercent = 0,
  lpBurned = false,
  lpLocked = false,
  antiWhale = false,
  buyTax = 0,
  sellTax = 0,
  topHolderPercent = 0,
  top10HoldersPercent = 0,
  smartMoneyBuying = "Unknown"
}) {
  let score = 100;
  const findings = [...warnings];
  const criticalFindings = [];

  if (isHoneypot) {
    score -= 100;
    criticalFindings.push("Honeypot detected: Cannot sell tokens.");
  }
  if (isMintable) {
    score -= 40;
    findings.push("Mint function active: Token supply can be increased by creator.");
  }
  if (isProxy) {
    score -= 20;
    findings.push("Upgradeable proxy contract: Contract logic can be modified.");
  }
  if (!ownershipRenounced && !isRenounced) {
    score -= 30;
    criticalFindings.push("Ownership not renounced: Creator retains control over the contract.");
  }

  if (liquidity < 1000) {
    score -= 50;
    criticalFindings.push("Extremely low liquidity: High price impact and potential for rug pull.");
  } else if (liquidity < 10000) {
    score -= 30;
    findings.push("Low liquidity: Significant price impact on trades.");
  } else if (liquidity < 50000) {
    score -= 10;
    findings.push("Moderate liquidity: May experience some price impact.");
  }

  if (volume < liquidity * 0.01) {
    score -= 20;
    findings.push("Very weak trading activity: Low interest or potential for manipulation.");
  } else if (volume < liquidity * 0.05) {
    score -= 10;
    findings.push("Weak trading activity: Limited market interest.");
  }

  if (top10HoldersPercent > 80) {
    score -= 40;
    criticalFindings.push("Extreme holder concentration: Whales can dump tokens, causing massive price drops.");
  } else if (top10HoldersPercent > 60) {
    score -= 25;
    findings.push("High holder concentration: Risk of price manipulation by large holders.");
  } else if (top10HoldersPercent > 40) {
    score -= 10;
    findings.push("Moderate holder concentration.");
  }

  if (devHolding > 30) {
    score -= 35;
    criticalFindings.push("High developer token holding: Risk of developer selling off tokens.");
  } else if (devHolding > 15) {
    score -= 15;
    findings.push("Moderate developer token holding.");
  }

  if (buyTax > 10 || sellTax > 10) {
    score -= 40;
    criticalFindings.push(`Excessive trading taxes detected: Buy Tax: ${buyTax}%, Sell Tax: ${sellTax}%.`);
  } else if (buyTax > 5 || sellTax > 5) {
    score -= 15;
    findings.push(`High trading taxes detected: Buy Tax: ${buyTax}%, Sell Tax: ${sellTax}%.`);
  }

  if (lpBurned === false && lpLocked === false) {
    score -= 50;
    criticalFindings.push(
      "Liquidity not locked or burned: High risk of rug pull."
    );
  }

  if (!antiWhale) {
    score -= 5;
    findings.push("No anti-whale mechanism detected: Large buys/sells could impact price.");
  }

  if (creatorBalance > 0 && creatorPercent > 5 && devHolding === 0) {
    score -= 10;
    findings.push(`Creator holds ${creatorPercent}% of supply: Potential for large sell-offs.`);
  }

  if (criticalFindings.length > 0) {
    score = Math.min(score, 35);
  }

  score = Math.max(0, Math.min(100, score));

  let riskLevel = score >= 85 ? "VERY LOW" :
                 score >= 70 ? "LOW" :
                 score >= 50 ? "MEDIUM" :
                 score >= 30 ? "HIGH" : "EXTREME";

  if (criticalFindings.length > 0) riskLevel = "EXTREME";

  return {
    score,
    riskLevel,
    warnings: [...criticalFindings, ...findings],
    checks: {
      mintRevoked: !isMintable,
      freezeRevoked: !isHoneypot,
      largestHolderPercent:
    topHolderPercent == null
        ? "Unknown"
        : topHolderPercent.toFixed(2),

top10HoldersPercent:
    top10HoldersPercent == null
        ? "Unknown"
        : top10HoldersPercent.toFixed(2),

devTeamOwns:
    creatorPercent == null
        ? "Unknown"
        : creatorPercent.toFixed(2),
      lpBurned,
      lpLocked,
      smartMoneyBuying,
      isOrganic: volume > liquidity * 0.05 && volume < liquidity * 5,
      tokenAgeDays: 0
    }
  };
}

function generateFastReply(token, chain) {
  return [
    `📊 TOKEN RISK REPORT (FAST ESTIMATE)`,
    `─`.repeat(40),
    `Token Address: ${token}`,
    `Chain Target:  ${chain.toUpperCase()}`,
    ``,
    `📈 MARKET DATA`,
    `  Liquidity Pool Status: Fetching On-Chain Pairs...`,
    ``,
    `🚨 OVERALL ESTIMATED RISK: PENDING 🟡`,
    `  Asynchronous pipeline tracking active. Content updating shortly.`
  ].join("\n");
}

async function performDeepScan(detectedToken, chain, chainId) {
  const market = await callDexScreener(detectedToken);
  let pair = null;
  if (market?.pairs?.length) {
    pair = market.pairs.filter(p => p.liquidity?.usd > 0)
                 .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  }

  let liquidity = pair?.liquidity?.usd || 0;
  let volume = pair?.volume?.h24 || 0;
  let warnings = [];
  let criticalWarnings = 0;

  let isMintable = false, isHoneypot = false, isProxy = false, ownershipRenounced = true;
  let devHolding = null;
  let creatorPercent = null;

  let lpBurned = null;
  let lpLocked = null;

  let antiWhale = false;
  let buyTax = 0;
  let sellTax = 0;

  let topHolderPercent = null;
  let top10HoldersPercent = null;
  let smartMoneyBuying = "Unknown";

  let rugReport = null;

  if (chain === "evm") {
    rugReport = await callGoPlus(pair?.chainId || chainId, detectedToken);
    const targetKey = detectedToken.toLowerCase();
    const info = rugReport?.result?.[targetKey] || rugReport?.result?.[detectedToken];

    if (info) {
      isHoneypot = info.is_honeypot === "1";
      isMintable = info.is_mintable === "1";
      isProxy = info.is_proxy === "1";
      const isRenounced = info.owner_address === "0x0000000000000000000000000000000000000000";
      ownershipRenounced = isRenounced;

      buyTax = parseFloat(info.buy_tax || 0);
      sellTax = parseFloat(info.sell_tax || 0);
      lpLocked = info.lp_locked === "1" || (info.lp_holders && info.lp_holders.some(h => h.is_locked === 1));
      lpBurned = info.lp_burned === "1" || (info.lp_holders && info.lp_holders.some(h => 
        h.address === "0x000000000000000000000000000000000000dead" || 
        h.address === "0x0000000000000000000000000000000000000000"
      ));
      antiWhale = info.anti_whale_modifiable === "0";
      creatorPercent = parseFloat(info.creator_percent || 0);

      if (info.holders) {
        topHolderPercent = parseFloat(info.holders[0]?.percent || 0) * 100;
        top10HoldersPercent = info.holders.slice(0, 10).reduce((acc, h) => acc + parseFloat(h.percent || 0), 0) * 100;
      }
    }
      } else if (chain === "solana") {
    rugReport = await callRugCheck(detectedToken);

    fs.writeFileSync(
        "rugcheck-debug.json",
        JSON.stringify(rugReport, null, 2)
    );

    if (rugReport) {
      // Risks
      if (rugReport.risks && Array.isArray(rugReport.risks)) {
        rugReport.risks.forEach(r => {
          if (r.level === "danger") {
            warnings.push(`${r.name || r.message} [CRITICAL]`);
            criticalWarnings++;
          } else if (r.level === "warning") {
            warnings.push(r.name || r.message);
          }
        });
      }

      // Top holders
      if (Array.isArray(rugReport.topHolders)) {
        const holders = rugReport.topHolders;

        if (holders.length) {
          topHolderPercent =
              holders[0].pct ??
              holders[0].percentage ??
              null;

          top10HoldersPercent =
              holders
                  .slice(0,10)
                  .reduce(
                      (sum,h)=>
                          sum + (
                              h.pct ??
                              h.percentage ??
                              0
                          ),
                      0
                  );
        }
      }

      // Creator / Dev
      creatorPercent =
    rugReport.creatorPercentage ??
    rugReport.creatorPercent ??
    rugReport.creatorTokens ??
    null;

      devHolding = creatorPercent;

      // Improved LP Status detection
      lpBurned = null;
      lpLocked = null;

      if (rugReport.markets && Array.isArray(rugReport.markets)) {
        for (const market of rugReport.markets) {
          if (market.lp) {
            if ((market.lp.lpLockedPct && market.lp.lpLockedPct > 80) || 
                (market.lp.lpLocked && market.lp.lpLocked > 0)) {
              lpLocked = true;
            }
            if (market.lp.pctReserve === 100 || 
                (market.lp.lpUnlocked === 0 && market.lp.lpLocked > 0)) {
              lpBurned = true;
            }
          }
        }
      }

      // Fallbacks
      if (!lpLocked && rugReport.lockers && Object.keys(rugReport.lockers).length > 0) {
        lpLocked = true;
      }
      if (rugReport.lockerScanStatus === "locked" || rugReport.lockerOwners) {
        lpLocked = true;
      }
      if (rugReport.risks?.some(r => r.name === "LP Burned" || r.name === "Liquidity Burned")) {
        lpBurned = true;
      }
    }
  }

  const risk = calculateRisk({
    liquidity, volume, warnings, criticalWarnings,
    isMintable, isHoneypot, isProxy, ownershipRenounced,
    devHolding, creatorPercent, lpBurned, lpLocked, antiWhale,
    buyTax, sellTax, topHolderPercent, top10HoldersPercent, smartMoneyBuying
  });

  let reportLines = [
    `📊 TOKEN RISK REPORT`,
    `─`.repeat(40),
    `Asset Name:   ${pair?.baseToken?.name || "Unknown"} (${pair?.baseToken?.symbol || "???"})`,
    `Address:      ${detectedToken}`,
    `Chain Node:   ${chain.toUpperCase()}`,
    ``,
    `📈 MARKET DATA`,
    `  Price USD:  $${pair?.priceUsd ? Number(pair.priceUsd).toFixed(6) : "0.00"}`,
    `  Liquidity:  $${Number(liquidity).toLocaleString()}`,
    `  24h Volume: $${Number(volume).toLocaleString()}`,
    ``,
    `🐋 HOLDER METRICS`,
    `  Top Holder: ${risk.checks.largestHolderPercent}%`,
    `  Top 10 Holders: ${risk.checks.top10HoldersPercent}%`,
    `  Creator Wallet: ${risk.checks.devTeamOwns}%`,
    ``,
    `🛡 SECURITY STATUS`,
    `  LP Burned: ${
      risk.checks.lpBurned === null
        ? "Unknown"
        : risk.checks.lpBurned
        ? "🔥 Yes"
        : "❌ No"
    }`,
    `  LP Locked: ${
      risk.checks.lpLocked === null
        ? "Unknown"
        : risk.checks.lpLocked
        ? "🔒 Yes"
        : "❌ No"
    }`,
    `  Smart Money Buying: ${risk.checks.smartMoneyBuying}`,
    ``
  ];

  if (risk.warnings.length) {
    reportLines.push(`⚠ DETECTED VULNERABILITIES:`);
    risk.warnings.forEach(w => reportLines.push(`  - ${w}`));
    reportLines.push(``);
  }

  let reliability = 100;

  if (!rugReport) reliability -= 30;
  if (!market) reliability -= 20;

  if (topHolderPercent == null) reliability -= 10;
  if (creatorPercent == null) reliability -= 10;
  if (lpLocked == null) reliability -= 10;
  if (lpBurned == null) reliability -= 10;

  reliability = Math.max(reliability, 10);

  reportLines.push(`📊 DATA RELIABILITY: ${reliability}%`);
  reportLines.push(`🛡 SAFETY SCORE: ${risk.score}/100`);
  reportLines.push(`🚨 RISK LEVEL: ${risk.riskLevel}`);
  reportLines.push(``);
  reportLines.push(`✅ Mint authority revoked? ${risk.checks.mintRevoked ? "Yes" : "No"}`);
  reportLines.push(`✅ Freeze authority revoked? ${risk.checks.freezeRevoked ? "Yes" : "No"}`);
  reportLines.push(`✅ Largest holder: ${risk.checks.largestHolderPercent}%`);
  reportLines.push(`✅ Dev/Team owns: ${risk.checks.devTeamOwns}%`);
  reportLines.push(`✅ Volume profile: ${risk.checks.isOrganic ? "Organic" : "Potential Wash/Low Activity"}`);

  if (pair?.pairCreatedAt) {
    const ageDays = Math.floor((Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60 * 24));
    reportLines.push(`✅ Token age: ${ageDays} days`);
  } else {
    reportLines.push(`✅ Token age: Unknown (Freshly deployed?)`);
  }

  return {
    summaryText: reportLines.join("\n"),
    isComplete: true,
    telemetry: { token: detectedToken, risk: risk.riskLevel, liquidity, volume }
  };
}

// ============================================================
//  CENTRAL MATRIX ROUTE INTERFACE
// ============================================================
app.post("/chat", async (req, res) => {
  try {
    const { message, sessionId = "default", chainId = "1" } = req.body;
    let detectedToken = extractTokenFromMessage(message);
    let chain = "unknown";

    if (!detectedToken) {
      const resolved = await resolveTokenToAddress(message.trim());
      if (resolved) {
        detectedToken = resolved.address;
        chain = resolved.chain;
      }
    }

    // TOKEN ANALYSIS PATH
    if (detectedToken) {
      if (chain === "unknown") chain = getChainType(detectedToken);

      if (chain === "unknown") {
        return res.json({ reply: "Detected address string notation, but signatures match no known blockchain networks or token name/symbol could not be resolved." });
      }

      const cachedReport = getCached(`final-report-${detectedToken}`);
      if (cachedReport) {
        lastAnalysis.set(sessionId, cachedReport.telemetry);
        updateConversation(sessionId, "assistant", cachedReport.summaryText);
        return res.json({ reply: cachedReport.summaryText, isComplete: true });
      }

      const timeoutRacePromise = new Promise(resolve => {
        setTimeout(() => {
          resolve({ isFallback: true, summaryText: generateFastReply(detectedToken, chain) });
        }, CONFIG.RACE_TIMEOUT_MS);
      });

      const deepAnalysisPromise = performDeepScan(detectedToken, chain, chainId).then(report => {
        setCache(`final-report-${detectedToken}`, report);
        return report;
      });

      const winner = await Promise.race([deepAnalysisPromise, timeoutRacePromise]);

      if (winner.isFallback) {
        deepAnalysisPromise.then(fullReport => {
          lastAnalysis.set(sessionId, fullReport.telemetry);
        });
        updateConversation(sessionId, "assistant", winner.summaryText);
        return res.json({ reply: winner.summaryText, isComplete: false, token: detectedToken });
      }

      lastAnalysis.set(sessionId, winner.telemetry);
      updateConversation(sessionId, "assistant", winner.summaryText);
      return res.json({ reply: winner.summaryText, isComplete: true });
    }

    // CONTEXTUAL ADVICE PATH
    const last = lastAnalysis.get(sessionId);
    if (last && /(buy|sell|safe|risk|worth)/i.test(message)) {
      let advice = last.risk === "EXTREME" ? "🚨 Extreme signature threats detected. Direct execution highly discouraged." :
                   last.risk === "HIGH" ? "⚠️ High signature threats detected. Direct execution highly discouraged." :
                   last.risk === "MEDIUM" ? "⚠️ Mid-tier manipulation present. Exercise guarded entries." :
                   "✅ Baseline metrics clear. Observe external macro market swings.";

      const contextualResponse = [
        `System reference frame recalled for last scanned token contract node:`,
        `Target Hash: ${last.token}`,
        `Risk Status: ${last.risk}`,
        `Pool Depth:  $${Number(last.liquidity).toLocaleString()}`,
        ``,
        `👉 ${advice}`
      ].join("\n");

      updateConversation(sessionId, "assistant", contextualResponse);
      return res.json({ reply: contextualResponse, isComplete: true });
    }

    // GENERAL CHAT PATH
    if (!message?.trim()) {
      return res.status(400).json({ reply: "Input tracking buffer empty." });
    }

    updateConversation(sessionId, "user", message);
    const history = getConversation(sessionId);

    const systemInstruction = {
      role: "user",
      content: systemPrompt
    };

    const combinedHistory = [systemInstruction, ...history];

    const aiReply = await raceToSuccess([
      callGemini(combinedHistory),
      callGroq(combinedHistory)
    ]);

    if (aiReply) {
      updateConversation(sessionId, "assistant", aiReply);
      return res.json({ reply: aiReply, isComplete: true });
    }

    return res.status(500).json({ reply: "Upstream intelligence arrays unresponsive. Check endpoint keys." });

  } catch (err) {
    logger.error("Global boundary failure cascade:", err);
    return res.status(500).json({ reply: "Central operational system interruption." });
  }
});

app.post("/api/analyze/upgrade", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ available: false });
  const completedReport = getCached(`final-report-${token}`);
  if (completedReport) {
    return res.json({ available: true, report: completedReport });
  }
  return res.json({ available: false });
});

// ============================================================
//  START SERVER
// ============================================================
app.listen(CONFIG.PORT, () => console.log(`🔥 Dual-Engine Matrix Operational on Port ${CONFIG.PORT}`));